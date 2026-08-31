import {tierLabel} from './audiences';
import {CHANNELS} from './channels';

// Annotation text is merchant-facing. It takes the registry's label.
const channelLabel = (channel) => CHANNELS[channel]?.label ?? channel;

// [START campaign-dashboard.promoted-products]
export const productId = (gid) => String(gid).split('/').at(-1);

// The filter string interpolates the ID. Only digits get through.
export function promotedFilter(campaign) {
  const ids = (campaign.products ?? [])
    .map((product) => productId(product.id))
    .filter((id) => /^\d+$/.test(id));
  if (ids.length === 0) return null;
  return `product_id IN (${ids.join(', ')})`;
}

export const promotedNames = (campaign) =>
  (campaign.products ?? []).map((product) => product.title).join(', ');
// [END campaign-dashboard.promoted-products]

// `Number('abc')` is NaN, and a bare `<= 0` waves it through.
export const isPositiveAmount = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0;

// Every date reaches a ShopifyQL range or a target's startedAt. A string that
// isn't a real calendar day fails there, and the error never names the field.
export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === String(value)
  );
}

// The selection arrives as a JSON string. A payload the server can't read returns
// null, and an empty array is a cleared selection.
export function parseProducts(input) {
  let parsed;
  try {
    parsed = JSON.parse(String(input ?? '[]'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((product) => product && typeof product === 'object')
    .map((product) => ({
      id: String(product.id ?? ''),
      title: String(product.title ?? '').trim().slice(0, 255),
    }))
    .filter((product) => /^gid:\/\/shopify\/Product\/\d+$/.test(product.id))
    .slice(0, 5);
}

export function safeLocale(value) {
  if (!value) return 'en';
  try {
    Intl.NumberFormat.supportedLocalesOf(value);
    return value;
  } catch {
    return 'en';
  }
}

// `today` is a token ShopifyQL resolves in the store's timezone, and this date is UTC.
// A store west of UTC is still on the previous day. Wait a day before using the token.
export function campaignWindow(campaign) {
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  const running = campaign.startDate < today;
  const until = running && campaign.endDate > today ? 'today' : campaign.endDate;
  return `SINCE ${campaign.startDate} UNTIL ${until}`;
}

// Timestamps read back in the shop's timezone, and midnight UTC lands on the
// previous day east of it. Resolve a calendar date to 9am there.
export function shopMorning(date, timeZone) {
  const guess = new Date(`${date}T09:00:00Z`);
  if (!timeZone) return guess.getTime();
  const shift =
    new Date(guess.toLocaleString('en-US', {timeZone: 'UTC'})).getTime() -
    new Date(guess.toLocaleString('en-US', {timeZone})).getTime();
  return guess.getTime() + shift;
}

// `app_events` holds 30 days, and a window reaching further back fails outright.
// Clamp to relative tokens. ShopifyQL resolves them in the store's timezone.
const RECENT_DAYS = 29;

export function recentWindow(campaign) {
  const day = (offset) =>
    new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const floor = day(RECENT_DAYS);
  // A campaign that ended before the retained days has no events left to count.
  if (campaign.endDate < floor) return `SINCE -${RECENT_DAYS}d UNTIL -${RECENT_DAYS}d`;
  const since = campaign.startDate < floor ? `-${RECENT_DAYS}d` : campaign.startDate;
  const running = campaign.startDate <= day(0);
  const until = running && campaign.endDate > day(0) ? 'today' : campaign.endDate;
  return `SINCE ${since} UNTIL ${until}`;
}

// Only the owning app can change an app-owned definition. Writes take the `$app:`
// alias. Reads and analytics columns take the namespace it resolves to.
export const DIMENSION_NAMESPACE = '$app:campaign_dashboard';

export const dimensionNamespace = (appId) =>
  `app--${String(appId).split('/').at(-1)}--campaign_dashboard`;

export const metafieldDimension = (appId, owner, key) =>
  `${owner}.metafields."${dimensionNamespace(appId)}".${key}`;

// UTC arithmetic. A local midnight date reports as the previous day east of UTC.
export function withinWindow(campaign, offsetDays) {
  const [year, month, date] = campaign.startDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + offsetDays));
  const day = shifted.toISOString().slice(0, 10);
  return day > campaign.endDate ? campaign.endDate : day;
}

// List the names while they fit the annotation's cap, then fall back to a count.
const nameList = (names) =>
  names.length > 3
    ? `${names.length} creators`
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

// [START campaign-dashboard.campaign]
export function campaignMarks(campaign) {
  const channels = campaign.channels ?? [];
  const tier = tierLabel(campaign.audience);
  const creators = [
    ...new Set(creatorCodes(campaign).map((pair) => pair.creator)),
  ];

  const marks = [
    {
      key: 'campaign',
      type: 'campaign',
      title: campaign.title,
      description: `Ran on ${channels.map(channelLabel).join(', ') || 'no channels'}.`,
      date: campaign.startDate,
      // The only span. Everything else happened at an instant.
      ranged: true,
    },
    {
      key: 'launch',
      // Defaults to a plain product. `resolveLaunchMark` upgrades it for a bundle.
      type: 'product_launch',
      title: `${campaign.title} collection on sale`,
      description: 'The collection went on sale.',
      date: campaign.startDate,
    },
    {
      key: 'vip',
      // The closest documented type. The text names the tier.
      type: 'loyalty_program_offer',
      title: `Early access for ${tier}`,
      description: `${tier} shopped it first.`,
      date: withinWindow(campaign, 1),
    },
    ...(creators.length
      ? [
          {
            key: 'creator',
            type: 'influencer_collaboration',
            // `title` names the campaign on the store's chart, beside other
            // campaigns' marks. `label` is the in-app short form.
            label: 'Influencer drop',
            title: `Influencer drop for ${campaign.title}`,
            description:
              creators.length === 1
                ? `${creators[0]} posted with a discount code of their own.`
                : `${nameList(creators)} posted, each with a discount code of their own.`,
            date: withinWindow(campaign, 11),
          },
        ]
      : []),
    {
      key: 'promo',
      type: 'buy_x_get_y_discount',
      label: 'BOGO offer',
      title: `BOGO offer on ${campaign.title}`,
      description: 'Buy two, get one free.',
      date: withinWindow(campaign, 8),
    },
  ];

  // The events report `SEQUENCE`. Both the day and the name come from it.
  // A mark named for a send that never went out reads as that send on the chart.
  const sends = {
    email: {offset: 0, title: 'Announcement', did: 'Opened the campaign for'},
    push: {offset: 5, title: 'App exclusive', did: 'Went to the app for'},
    sms: {offset: 13, title: 'Final hours', did: 'Closed the campaign for'},
  };
  for (const channel of channels) {
    const send = sends[channel] ?? {offset: 0, title: channelLabel(channel), did: 'Went to'};
    marks.push({
      key: channel,
      type: 'campaign',
      label: send.title,
      title: `${send.title} for ${campaign.title}`,
      description: `${send.did} ${tier}.`,
      date: withinWindow(campaign, send.offset),
    });
  }

  // Titles cap at 75 characters, descriptions at 150. Both hold a name the user typed.
  return marks.map((mark) => ({
    ...mark,
    title: clamp(mark.title, 75),
    description: clamp(mark.description, 150),
  }));
}

export const clamp = (value, max) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
// [END campaign-dashboard.campaign]

// [START campaign-dashboard.last-touch]
// Only marks that reached a customer can attribute an order. The collection going on
// sale isn't a touch.
const TOUCH_KEYS = ['email', 'push', 'creator', 'promo', 'sms'];

// The touches the creators drove. Match on title, the field the order stores.
const CREATOR_KEYS = ['creator'];

export const creatorTouches = (campaign) =>
  touchMarks(campaign)
    .filter((mark) => CREATOR_KEYS.includes(mark.key))
    .map((mark) => mark.title);

export const touchMarks = (campaign) =>
  campaignMarks(campaign)
    .filter((mark) => TOUCH_KEYS.includes(mark.key))
    .sort((first, second) => first.date.localeCompare(second.date));

export const lastTouch = (touches, day) =>
  touches.filter((mark) => mark.date <= day).at(-1)?.title ?? null;
// [END campaign-dashboard.last-touch]

// [START campaign-dashboard.creator-codes]
export const sanitizeCode = (code) =>
  String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '');

export function parseCreatorCodes(input) {
  return String(input ?? '')
    .split(',')
    .map((entry) => {
      const [code, creator] = entry.split(':');
      return {code: sanitizeCode(code), creator: (creator ?? code ?? '').trim()};
    })
    .filter((pair) => pair.code && pair.creator);
}

export const creatorCodes = (campaign) => campaign.creatorCodes ?? [];

// The codes as ShopifyQL sees them. Sanitized on the way in, leaving quoting as
// the only job here.
export const codeFilter = (campaign) => {
  const codes = creatorCodes(campaign).map((pair) => `'${pair.code}'`);
  return codes.length ? `discount_code IN (${codes.join(', ')})` : null;
};
// [END campaign-dashboard.creator-codes]

// Everything the loader and the browser derive from a stored campaign record.
import {tierLabel} from './audiences';
import {CHANNELS} from './channels';

// Annotation text is merchant-facing. It takes the registry's label.
const channelLabel = (channel) => CHANNELS[channel]?.label ?? channel;

// [START campaign-dashboard.promoted-products]
// The picker hands back GIDs. ShopifyQL wants the numeric part.
export const productId = (gid) => String(gid).split('/').at(-1);

// The ID is interpolated into the filter string. Only digits get through, and a quoted
// number passes target create then fails when Shopify measures it.
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

// `Number('abc')` is NaN, and every comparison against NaN is false. A bare `<= 0`
// waves non-numeric input through to a mutation that rejects it on arrival.
export const isPositiveAmount = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0;

// The picker's selection arrives as a JSON string on the form. A payload the server
// can't read returns null, an empty array is a cleared selection, and the title lands
// in annotation text.
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
    // The picker allows five.
    .slice(0, 5);
}

// `Intl` throws on a malformed tag, and the locale arrives on a query parameter that
// nothing validates.
export function safeLocale(value) {
  if (!value) return 'en';
  try {
    Intl.NumberFormat.supportedLocalesOf(value);
    return value;
  } catch {
    return 'en';
  }
}

// A running campaign's window runs past today. Days that haven't happened report zero,
// which reads as a collapse on the chart and drags every average with it.
export function campaignWindow(campaign) {
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  const running = campaign.startDate <= today;
  const until = running && campaign.endDate > today ? 'today' : campaign.endDate;
  return `SINCE ${campaign.startDate} UNTIL ${until}`;
}

// Timestamps read back in the shop's timezone, where midnight UTC can be the day
// before. Resolve a calendar date to 9am there.
export function shopMorning(date, timeZone) {
  const guess = new Date(`${date}T09:00:00Z`);
  if (!timeZone) return guess.getTime();
  const shift =
    new Date(guess.toLocaleString('en-US', {timeZone: 'UTC'})).getTime() -
    new Date(guess.toLocaleString('en-US', {timeZone})).getTime();
  return guess.getTime() + shift;
}

// `app_events` holds 30 days, and a window reaching further back fails outright.
// Clamp to relative tokens, which ShopifyQL resolves in the store's timezone.
const RECENT_DAYS = 29;

export function recentWindow(campaign) {
  const day = (offset) =>
    new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const floor = day(RECENT_DAYS);
  const since =
    campaign.endDate >= floor && campaign.startDate < floor
      ? `-${RECENT_DAYS}d`
      : campaign.startDate;
  const running = campaign.startDate <= day(0);
  const until = running && campaign.endDate > day(0) ? 'today' : campaign.endDate;
  return `SINCE ${since} UNTIL ${until}`;
}

// The namespace the app's three dimensions live under. A readable namespace reads
// back as a readable column, where `$app` resolves to `app--<app_id>`.
export const DIMENSION_NAMESPACE = 'campaign_dashboard';

export const metafieldDimension = (owner, key) =>
  `${owner}.metafields."${DIMENSION_NAMESPACE}".${key}`;

// Keeps a derived date inside the campaign's window. UTC arithmetic, because a local
// midnight date reports as the previous day east of UTC.
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
// The moments a campaign is made of, each with a type from a different category so
// ANNOTATE can filter them apart, and each dated to when the thing happened.
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
      // The closest documented type. The tier is named in the text.
      type: 'loyalty_program_offer',
      title: `Early access for ${tier}`,
      description: `${tier} shopped it first.`,
      date: withinWindow(campaign, 1),
    },
    // Only when the campaign has creators.
    ...(creators.length
      ? [
          {
            key: 'creator',
            type: 'influencer_collaboration',
            // `title` names the campaign for the store's chart, where other
            // campaigns' marks sit beside it. `label` is the in-app short form.
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

  // Both the day and the name come from `SEQUENCE`, which is what the events report.
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

// The touches the creators drove. Matched by title, which is what the order stores.
const CREATOR_KEYS = ['creator'];

export const creatorTouches = (campaign) =>
  touchMarks(campaign)
    .filter((mark) => CREATOR_KEYS.includes(mark.key))
    .map((mark) => mark.title);

export const touchMarks = (campaign) =>
  campaignMarks(campaign)
    .filter((mark) => TOUCH_KEYS.includes(mark.key))
    .sort((first, second) => first.date.localeCompare(second.date));

// Last touch. An order that beat every send stays unattributed.
export const lastTouch = (touches, day) =>
  touches.filter((mark) => mark.date <= day).at(-1)?.title ?? null;
// [END campaign-dashboard.last-touch]

// [START campaign-dashboard.creator-codes]
// A code lands in a quoted string inside a GraphQL string. Drop what can't appear.
export const sanitizeCode = (code) =>
  String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '');

// `discount_code` groups by code. Only the app knows which creator owns which.
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

// The codes as ShopifyQL sees them. Sanitized on the way in, which leaves quoting.
export const codeFilter = (campaign) => {
  const codes = creatorCodes(campaign).map((pair) => `'${pair.code}'`);
  return codes.length ? `discount_code IN (${codes.join(', ')})` : null;
};
// [END campaign-dashboard.creator-codes]

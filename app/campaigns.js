// The campaign shape both the loader and the browser read. Everything here is
// derived from the stored record, so a second campaign gets its own markers,
// its own goals, and its own funnel without a code change.

import {CHANNELS} from './channels';

export const BOUNCE_ALERT_RATE = 0.02;

// Annotation titles and descriptions are merchant-facing, so they take the
// registry's label rather than the channel key the record stores.
const channelLabel = (channel) => CHANNELS[channel]?.label ?? channel;

// [START campaign-dashboard.promoted-products]
// A target filter needs product IDs, because a title can be edited out from
// under it. The picker hands back GIDs, and ShopifyQL wants the numeric part.
export const productId = (gid) => String(gid).split('/').at(-1);

export function promotedFilter(campaign) {
  const ids = (campaign.products ?? []).map((product) => productId(product.id));
  if (ids.length === 0) return null;
  // IN takes a bare list of numbers. Quoting them fails at query time with
  // "Enter a number only" rather than at create time.
  return `product_id IN (${ids.join(', ')})`;
}

export const promotedNames = (campaign) =>
  (campaign.products ?? []).map((product) => product.title).join(', ');
// [END campaign-dashboard.promoted-products]

export const campaignWindow = (campaign) =>
  `SINCE ${campaign.startDate} UNTIL ${campaign.endDate}`;

// An app-owned namespace is `app--` followed by the app's numeric ID, and the
// double hyphen isn't something a bare ShopifyQL identifier can hold. Quote it
// everywhere it appears in a query, or the query fails with `no viable
// alternative` at the namespace.
export const appNamespace = (appId) =>
  appId ? `app--${String(appId).split('/').at(-1)}` : null;

export const metafieldDimension = (owner, appId, key) => {
  const namespace = appNamespace(appId);
  return namespace ? `${owner}.metafields."${namespace}".${key}` : null;
};

// Keep a derived date inside the window. A sequence longer than the campaign
// would otherwise put markers past the end of every chart on the page.
function withinWindow(campaign, offsetDays) {
  const start = new Date(`${campaign.startDate}T00:00:00`);
  start.setDate(start.getDate() + offsetDays);
  const day = start.toISOString().slice(0, 10);
  return day > campaign.endDate ? campaign.endDate : day;
}

// [START campaign-dashboard.campaign]
// What the user should see on their charts. The campaign is a span that stays
// open until it ends. Everything inside it is an instant. That's what endedAt
// separates.
//
// A campaign isn't one event, so don't write it as one. Each of these is a
// separate thing a user might later want to isolate, and each carries a type
// from a different category so ANNOTATE can filter them apart. No type is
// channel-specific, so the channel goes in the title.
export function campaignMarks(campaign) {
  const channels = campaign.channels ?? [];
  const products = promotedNames(campaign) || 'the collection';

  const marks = [
    {
      key: 'campaign',
      type: 'campaign',
      title: campaign.title,
      description: `${campaign.title} across ${channels.map(channelLabel).join(', ') || 'no channels'}.`,
      date: campaign.startDate,
      // The only ranged mark. Everything else happened at an instant.
      ranged: true,
    },
    {
      key: 'launch',
      // The plan's guess. `resolveLaunchMark` checks the store before the write
      // and upgrades this to `bundle_launch` when the products are bundles.
      type: 'product_launch',
      title: `${products} live`,
      description: `${products} went on sale for ${campaign.title}.`,
      date: campaign.startDate,
    },
    {
      key: 'landing',
      type: 'landing_page_launch',
      title: `${campaign.title} landing page live`,
      description: 'Campaign page published, linked from every send.',
      date: campaign.startDate,
    },
    {
      key: 'promo',
      type: 'seasonal_promotion',
      title: `${campaign.title} discount live`,
      description: 'Campaign discount issued to every new lead.',
      date: campaign.startDate,
    },
  ];

  // One marker for each channel the sequence sends on, dated to the day that
  // channel's first touch goes out.
  const firstTouch = {email: 0, sms: 7, push: 3};
  for (const channel of channels) {
    marks.push({
      key: channel,
      type: 'campaign',
      title: `${campaign.title} ${channelLabel(channel)}`,
      description: `${channelLabel(channel)} sends for ${campaign.title}.`,
      date: withinWindow(campaign, firstTouch[channel] ?? 0),
    });
  }

  marks.push(
    {
      key: 'ads',
      type: 'ad_spend_change',
      title: `Paid boost behind ${campaign.title}`,
      description: 'Daily paid spend tripled behind the campaign creative.',
      date: withinWindow(campaign, 2),
    },
    {
      key: 'creator',
      type: 'influencer_collaboration',
      title: `Creator drop for ${campaign.title}`,
      description: 'Sponsored post and story series for the collection.',
      date: withinWindow(campaign, 5),
    },
  );

  // Titles are capped at 75 characters and descriptions at 150, and these are
  // built from a name the user typed.
  return marks.map((mark) => ({
    ...mark,
    title: clamp(mark.title, 75),
    description: clamp(mark.description, 150),
  }));
}

export const clamp = (value, max) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
// [END campaign-dashboard.campaign]

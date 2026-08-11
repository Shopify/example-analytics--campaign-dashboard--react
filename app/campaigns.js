// Everything the loader and the browser derive from a stored campaign record.
import {CHANNELS} from './channels';

export const BOUNCE_ALERT_RATE = 0.02;

// Annotation text is merchant-facing, so it takes the registry's label rather than
// the channel key the record stores.
const channelLabel = (channel) => CHANNELS[channel]?.label ?? channel;

// [START campaign-dashboard.promoted-products]
// A target filter needs product IDs, because a title can be edited out from under
// it. The picker hands back GIDs and ShopifyQL wants the numeric part.
export const productId = (gid) => String(gid).split('/').at(-1);

// IN takes a bare list of numbers. Quoting them fails at query time with "Enter a
// number only" rather than at create time.
export function promotedFilter(campaign) {
  const ids = (campaign.products ?? []).map((product) => productId(product.id));
  if (ids.length === 0) return null;
  return `product_id IN (${ids.join(', ')})`;
}

export const promotedNames = (campaign) =>
  (campaign.products ?? []).map((product) => product.title).join(', ');
// [END campaign-dashboard.promoted-products]

export const campaignWindow = (campaign) =>
  `SINCE ${campaign.startDate} UNTIL ${campaign.endDate}`;

// The double hyphen in `app--` isn't something a bare ShopifyQL identifier can hold,
// so quote the namespace or the query fails with `no viable alternative`.
export const appNamespace = (appId) =>
  appId ? `app--${String(appId).split('/').at(-1)}` : null;

export const metafieldDimension = (owner, appId, key) => {
  const namespace = appNamespace(appId);
  return namespace ? `${owner}.metafields."${namespace}".${key}` : null;
};

// Keeps a derived date inside the campaign's window. The arithmetic is UTC because
// `new Date('2026-08-01T00:00:00')` is local midnight, which `toISOString` reports
// as the previous day anywhere east of UTC.
function withinWindow(campaign, offsetDays) {
  const [year, month, date] = campaign.startDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + offsetDays));
  const day = shifted.toISOString().slice(0, 10);
  return day > campaign.endDate ? campaign.endDate : day;
}

// [START campaign-dashboard.campaign]
// A campaign isn't one event. Each of these is something a user might later want to
// isolate, so each carries a type from a different category and ANNOTATE can filter
// them apart. No type is channel-specific, so the channel goes in the title.
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
      // The only span. Everything else happened at an instant.
      ranged: true,
    },
    {
      key: 'launch',
      // A guess. `resolveLaunchMark` checks the store first and upgrades this to
      // `bundle_launch` when the products are bundles.
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

  // Titles are capped at 75 characters and descriptions at 150, and both are built
  // from a name the user typed.
  return marks.map((mark) => ({
    ...mark,
    title: clamp(mark.title, 75),
    description: clamp(mark.description, 150),
  }));
}

export const clamp = (value, max) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
// [END campaign-dashboard.campaign]

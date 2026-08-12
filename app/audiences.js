// [START campaign-dashboard.audience-tiers]
// Written onto each customer as an app-owned metafield at launch. A scalar, because
// that's what a ShopifyQL comparison holds.
export const AUDIENCE_TIERS = [
  {
    value: 'vip',
    label: 'VIP',
    // Ranked from the sales dataset, because CustomerSortKeys has no spend key.
    description: 'The 10 customers who spent the most in the last year.',
    size: 10,
  },
  {
    value: 'regulars',
    label: 'Regulars',
    // Below the VIPs, not alongside. `skip` becomes the ranking query's OFFSET.
    description: 'The next 25 customers by spend, below the VIPs.',
    size: 25,
    skip: 10,
  },
  {
    value: 'everyone',
    label: 'Everyone',
    description: 'No tier filter. The segment target matches the store-wide one.',
    size: 0,
  },
];

export const TIER_METAFIELD = {namespace: '$app', key: 'tier'};

export const tierLabel = (value) =>
  AUDIENCE_TIERS.find((tier) => tier.value === value)?.label ?? value;

// `everyone` measures the whole store. Nothing to filter on, no roster to write.
export const isTargetedTier = (value) => Boolean(value) && value !== 'everyone';
// [END campaign-dashboard.audience-tiers]

// [START campaign-dashboard.audience-tiers]
// The audience a campaign is aimed at, written onto each customer as an app-owned
// metafield at launch. A ShopifyQL comparison holds the value, so it stays a scalar.
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
    // Below the VIPs rather than alongside, so one tier isn't measured on the other's
    // customers. `skip` becomes the ranking query's OFFSET.
    description: 'The next 25 customers by spend, below the VIPs.',
    size: 25,
    skip: 10,
  },
  {
    value: 'everyone',
    label: 'Everyone',
    description: 'No tier filter, so the audience goal matches the store-wide one.',
    size: 0,
  },
];

export const TIER_METAFIELD = {namespace: '$app', key: 'tier'};

export const tierLabel = (value) =>
  AUDIENCE_TIERS.find((tier) => tier.value === value)?.label ?? value;

// A tier of `everyone` measures the whole store, so there's nothing to filter on
// and no roster to write.
export const isTargetedTier = (value) => Boolean(value) && value !== 'everyone';
// [END campaign-dashboard.audience-tiers]

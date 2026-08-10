// [START campaign-dashboard.audience-tiers]
// The audience a campaign is aimed at, written onto each customer as an
// app-owned metafield at launch. The value is what Step 13 filters the sales
// dataset by, so it has to be a plain scalar a ShopifyQL comparison can hold.
export const AUDIENCE_TIERS = [
  {
    value: 'vip',
    label: 'VIP',
    // Rank the audience with the sales dataset rather than the customer list.
    // CustomerSortKeys has no spend key, so the tier comes from what people
    // actually spent over the last year.
    description: 'The 10 customers who spent the most in the last year.',
    size: 10,
  },
  {
    value: 'lapsed',
    label: 'Lapsed',
    description: 'Customers who bought last year and not in the last 90 days.',
    size: 25,
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

// [START campaign-dashboard.annotate-clause]
// ANNOTATE takes `category.type`. The GraphQL Admin API takes the bare type.
export const CATEGORIES = {
  campaign: 'marketing_events',
  product_launch: 'product_events',
  bundle_launch: 'product_events',
  landing_page_launch: 'online_store_events',
  buy_x_get_y_discount: 'discount_events',
  loyalty_program_offer: 'discount_events',
  ad_spend_change: 'marketing_events',
  influencer_collaboration: 'marketing_events',
  brand_collaboration: 'marketing_events',
  revenue_milestone: 'operation_events',
  other: 'custom_events',
};

export function annotateClause(types) {
  return [
    ...new Set(
      [...types, 'revenue_milestone', 'other']
        .filter((type) => CATEGORIES[type])
        .map((type) => `${CATEGORIES[type]}.${type}`),
    ),
  ].join(', ');
}
// [END campaign-dashboard.annotate-clause]

// [START campaign-dashboard.explore-link]
export function exploreLink(query) {
  return `shopify://admin/analytics/reports/explore?ql=${encodeURIComponent(query)}`;
}

// The same query the sales chart draws, so the report opens on the chart the
// merchant just saw, targets included.
export function exploreQuery({window, types}) {
  return [
    'FROM sales',
    'SHOW total_sales, orders',
    'TIMESERIES day',
    window,
    'COMPARE TO TARGETS',
    'VISUALIZE total_sales TYPE bar, orders TYPE line',
    `ANNOTATE ${annotateClause(types)}`,
  ].join('\n');
}
// [END campaign-dashboard.explore-link]

// [START campaign-dashboard.analytics-link]
export function analyticsReportHref({window, annotations}) {
  return exploreLink(
    exploreQuery({
      window,
      types: annotations.map((annotation) => annotation.type),
    }),
  );
}
// [END campaign-dashboard.analytics-link]

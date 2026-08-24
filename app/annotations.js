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

// Built from the types the app resolved at read time.
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

// [START campaign-dashboard.category-colors]
// Colored by category, which makes the strip a legend for the ANNOTATE clause.
const CATEGORY_COLORS = {
  marketing_events: '#005bd3',
  product_events: '#29845a',
  online_store_events: '#8a6116',
  discount_events: '#8e44ad',
  operation_events: '#b98900',
  custom_events: '#c73e3e',
};

export const categoryOf = (type) => CATEGORIES[type] ?? 'custom_events';

export function annotationColor(annotation, appId) {
  if (annotation.createdByApp?.id !== appId) return '#8a8a8a';
  return CATEGORY_COLORS[categoryOf(annotation.type)] ?? '#005bd3';
}

export const CATEGORY_LABELS = {
  marketing_events: 'Marketing',
  product_events: 'Product',
  online_store_events: 'Online store',
  discount_events: 'Discount',
  operation_events: 'Operations',
  custom_events: 'Custom',
};

// One swatch per category present, with a count an overlapping strip would hide.
export function categoryLegend(annotations, appId) {
  const seen = new Map();
  for (const annotation of annotations) {
    if (annotation.createdByApp?.id !== appId) continue;
    const category = categoryOf(annotation.type);
    if (!seen.has(category)) {
      seen.set(category, {
        category,
        label: CATEGORY_LABELS[category] ?? category,
        color: CATEGORY_COLORS[category] ?? '#005bd3',
        count: 0,
      });
    }
    seen.get(category).count += 1;
  }
  return [...seen.values()];
}
// [END campaign-dashboard.category-colors]

// [START campaign-dashboard.explore-link]
// The report reads its window from the query's SINCE and UNTIL.
export function exploreLink(query) {
  return `shopify://admin/analytics/reports/explore?ql=${encodeURIComponent(query)}`;
}

export function exploreQuery({window, types, metric = 'total_sales'}) {
  return [
    'FROM sales',
    `SHOW ${metric}`,
    'TIMESERIES day',
    window,
    `VISUALIZE ${metric} TYPE line`,
    `ANNOTATE ${annotateClause(types)}`,
  ].join('\n');
}
// [END campaign-dashboard.explore-link]

// [START campaign-dashboard.analytics-link]
// The store's explorer, with the query already in it.
export function analyticsReportHref({window, annotations}) {
  return exploreLink(
    exploreQuery({
      window,
      types: annotations.map((annotation) => annotation.type),
    }),
  );
}
// [END campaign-dashboard.analytics-link]

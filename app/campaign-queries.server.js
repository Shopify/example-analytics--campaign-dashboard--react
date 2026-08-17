// Every GraphQL document this app sends. Campaign-dependent queries are builders.
import {campaignWindow, recentWindow} from './campaigns';
import {FUNNEL_METRICS, SEQUENCE_METRICS} from './channels';

// [START campaign-dashboard.shop-query]
// The store's timezone decides which day a dated write lands on.
export const SHOP_QUERY = `
  query CampaignShop {
    shop {
      id
      ianaTimezone
      currencyCode
    }
  }
`;
// [END campaign-dashboard.shop-query]

// [START campaign-dashboard.metafield-state]
// One app-data metafield holds every campaign, isolated by its AppInstallation owner.
export const STATE_NAMESPACE = 'campaign_dashboard';
export const STATE_KEY = 'campaigns';

// Returns the app's own ID, which tells this app's annotations from another app's.
export const STATE_QUERY = `
  query CampaignState {
    currentAppInstallation {
      id
      app {
        id
        title
      }
      metafield(namespace: "${STATE_NAMESPACE}", key: "${STATE_KEY}") {
        id
        value
      }
    }
  }
`;

// One mutation for the campaign list, product stamps, and audience tags.
export const METAFIELDS_SET = `
  mutation SetCampaignMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.metafield-state]

// [START campaign-dashboard.query]
// TIMESERIES buckets by the shop's timezone rather than UTC.
export const salesQuery = (campaign) => `
  query CampaignSales {
    shop {
      id
      currencyCode
      ianaTimezone
    }
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders TIMESERIES day ${campaignWindow(campaign)} COMPARE TO previous_period WITH TOTALS ORDER BY day ASC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.query]

// [START campaign-dashboard.optional-query]
// A factory. Two skipped panels then don't share one rows array.
export const emptyTable = () => ({
  tableData: {columns: [], rows: []},
  parseErrors: [],
  unavailable: null,
});

// An unreachable dataset fails the whole request. A parse error nulls tableData.
export async function runOptional(admin, query) {
  try {
    const body = await (await admin.graphql(query)).json();
    if (body.errors?.length) {
      return {...emptyTable(), unavailable: body.errors[0].message};
    }
    const result = body.data?.shopifyqlQuery;
    return {
      ...emptyTable(),
      tableData: result?.tableData ?? emptyTable().tableData,
      parseErrors: result?.parseErrors ?? [],
    };
  } catch (error) {
    return {...emptyTable(), unavailable: error.message};
  }
}
// [END campaign-dashboard.optional-query]

// [START campaign-dashboard.target]
export const TARGET_CREATE = `
  mutation CreateCampaignTarget($input: AnalyticsTargetCreateInput!) {
    analyticsTargetCreate(input: $input) {
      analyticsTarget {
        id
        name
        metric
        expectedValue
        filters
        shopifyqlQuery
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// Only the fields you pass change. Raising a target leaves the metric and filters alone.
export const TARGET_UPDATE = `
  mutation RaiseCampaignTarget($id: ID!, $input: AnalyticsTargetUpdateInput!) {
    analyticsTargetUpdate(id: $id, input: $input) {
      analyticsTarget {
        id
        name
        expectedValue
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const TARGETS_DELETE = `
  mutation DeleteCampaignTargets($ids: [ID!]!) {
    analyticsTargetsDelete(ids: $ids) {
      deletedIds
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.target]

// [START campaign-dashboard.target-read]
// Shopify generates each target's `shopifyqlQuery` from its metric, dates, and filters.
export const targetsQuery = (campaign) => `
  query CampaignTargets {
    analyticsTargets(first: 10, query: "start_date:${campaign.startDate}") {
      nodes {
        id
        name
        metric
        expectedValue
        currencyCode
        startDate
        endDate
        filters
        shopifyqlQuery
      }
    }
  }
`;

// [END campaign-dashboard.target-read]

// [START campaign-dashboard.all-targets-read]
// Every campaign's targets in one request. Not app-scoped — match on `startDate`.
export const ALL_TARGETS_QUERY = `
  query StoreTargets {
    analyticsTargets(first: 50) {
      nodes {
        id
        metric
        expectedValue
        startDate
        shopifyqlQuery
      }
    }
  }
`;
// [END campaign-dashboard.all-targets-read]

// [START campaign-dashboard.target-progress]
// Aliasing the plain `shopifyqlQuery` field measures every target in one request.
export function progressQuery(targets) {
  const fields = targets
    .map(
      (target, index) =>
        `t${index}: shopifyqlQuery(query: ${JSON.stringify(target.shopifyqlQuery)}) {
          tableData { rows }
          parseErrors
        }`,
    )
    .join('\n');
  return `query TargetProgress {\n${fields}\n}`;
}

// The generated query selects one metric. Its single row holds one value.
export function progressValue(result) {
  if (!result || result.parseErrors?.length) return null;
  const row = result.tableData?.rows?.[0];
  if (!row) return 0;
  return Number(Object.values(row)[0] ?? 0);
}

// Re-measuring one target before writing a permanent annotation for it.
export const measureQuery = (generated) => `
  query MeasureTarget {
    shopifyqlQuery(query: ${JSON.stringify(generated)}) {
      tableData { rows }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.target-progress]

// [START campaign-dashboard.annotation-create]
export const ANNOTATION_CREATE = `
  mutation CreateCampaignAnnotation($input: AnalyticsAnnotationCreateInput!) {
    analyticsAnnotationCreate(input: $input) {
      analyticsAnnotation {
        id
        type
        title
        startedAt
        endedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.annotation-create]

// [START campaign-dashboard.bundle-query]
// A bundle and a plain product take different annotation types.
export const BUNDLE_QUERY = `
  query PromotedProductKinds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        hasVariantsThatRequiresComponents
      }
    }
  }
`;
// [END campaign-dashboard.bundle-query]

// [START campaign-dashboard.annotation-update]
// Only the fields you pass change. An annotation can be rewritten with what happened.
export const ANNOTATION_UPDATE = `
  mutation CloseCampaignAnnotation($id: ID!, $input: AnalyticsAnnotationUpdateInput!) {
    analyticsAnnotationUpdate(id: $id, input: $input) {
      analyticsAnnotation {
        id
        title
        description
        startedAt
        endedAt
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.annotation-update]

// [START campaign-dashboard.annotation-delete]
// No bulk variant, and the removed ID comes back as `deletedId`.
export const ANNOTATION_DELETE = `
  mutation DeleteCampaignAnnotation($id: ID!) {
    analyticsAnnotationDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }
`;
// [END campaign-dashboard.annotation-delete]

// [START campaign-dashboard.annotation-read]
// Hangs off Shop, sorted by ID unless told otherwise. Filtered by window, not by app.
export const annotationsQuery = (campaign) => `
  query CampaignAnnotations {
    currentAppInstallation {
      app {
        id
      }
    }
    shop {
      analyticsAnnotations(
        first: 50
        sortKey: STARTED_AT
        query: "started_at:>=${campaign.startDate} started_at:<=${campaign.endDate}"
      ) {
        nodes {
          id
          type
          title
          description
          startedAt
          endedAt
          source
          createdByApp {
            id
            title
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;
// [END campaign-dashboard.annotation-read]

// [START campaign-dashboard.app-events-query]
// These columns exist only because the extension declares the matching standard events.
export const appEventsQuery = (campaign) => `
  query CampaignFunnel {
    shopifyqlQuery(
      query: "FROM app_events SHOW ${FUNNEL_METRICS.join(', ')} WHERE campaign_id = ${campaign.id} TIMESERIES day ${recentWindow(campaign)} ORDER BY day ASC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.app-events-query]

// [START campaign-dashboard.slice-queries]
// Attribute dimensions reach back 30 days, and SINCE -30d UNTIL today spans 31.
// Grouped by `app_name` too: campaign IDs aren't unique across apps.
export const sliceQuery = () => `
  query CampaignComparison {
    shopifyqlQuery(
      query: "FROM app_events SHOW emails_sent, emails_opened, sms_messages_sent, push_notifications_sent GROUP BY campaign_id, app_name SINCE -29d UNTIL today ORDER BY emails_sent DESC"
    ) {
      tableData {
        columns {
          name
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.slice-queries]

// [START campaign-dashboard.sequence-query]
// All three channels' metrics share one SHOW. Each row fills only its own columns.
export const sequenceQuery = (campaign) => `
  query CampaignSequence {
    shopifyqlQuery(
      query: "FROM app_events SHOW ${SEQUENCE_METRICS.join(', ')} WHERE campaign_id = ${campaign.id} GROUP BY template_id SINCE -29d UNTIL today ORDER BY template_id ASC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.sequence-query]

// [START campaign-dashboard.bounce-query]
// `recipient_status` separates a hard bounce, a dead address, from a temporary one.
export const bounceQuery = (campaign) => `
  query CampaignBounces {
    shopifyqlQuery(
      query: "FROM app_events SHOW emails_bounced WHERE campaign_id = ${campaign.id} GROUP BY recipient_status SINCE -29d UNTIL today ORDER BY emails_bounced DESC"
    ) {
      tableData {
        columns {
          name
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.bounce-query]


// [START campaign-dashboard.metafield-capability]
// Eligibility depends on owner type and field type. Read it before offering the control.
export const DEFINITION_QUERY = `
  query AppMetafieldDefinitions($namespace: String!) {
    products: metafieldDefinitions(
      first: 1
      ownerType: PRODUCT
      namespace: $namespace
      key: "promoted_by"
    ) {
      nodes {
        id
        key
        namespace
        ownerType
        capabilities {
          analyticsQueryable {
            eligible
            enabled
          }
        }
      }
    }
    orders: metafieldDefinitions(
      first: 1
      ownerType: ORDER
      namespace: $namespace
      key: "campaign_touch"
    ) {
      nodes {
        id
        key
        namespace
        ownerType
        capabilities {
          analyticsQueryable {
            eligible
            enabled
          }
        }
      }
    }
    customers: metafieldDefinitions(
      first: 1
      ownerType: CUSTOMER
      namespace: $namespace
      key: "tier"
    ) {
      nodes {
        id
        key
        namespace
        ownerType
        capabilities {
          analyticsQueryable {
            eligible
            enabled
          }
        }
      }
    }
  }
`;

// TOML can't set `analyticsQueryable`, and a definition declared there is read-only here.
export const DEFINITION_CREATE = `
  mutation CreateAnalyticsDimension($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        key
        namespace
        ownerType
        capabilities {
          analyticsQueryable {
            eligible
            enabled
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// No `id` field. It addresses the definition by key and owner type, neither changeable.
export const DEFINITION_UPDATE = `
  mutation EnableAnalyticsDimension($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition {
        id
        key
        capabilities {
          analyticsQueryable {
            enabled
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;
// [END campaign-dashboard.metafield-capability]

// ShopifyQL needs the double-hyphen namespace quoted, and those quotes have to survive
// being written inside a GraphQL string.
const inGraphQLString = (dimension) => dimension.replaceAll('"', '\\"');

// `AS` is what names the column, or it comes back as the whole dotted expression. A day
// bucket splits the window into the campaign's products and everything else.
export const promotedByQuery = (campaign, dimension) => `
  query CampaignPromotedSplit {
    shopifyqlQuery(
      query: "FROM sales SHOW ${inGraphQLString(dimension)} AS promoted_by, total_sales TIMESERIES day GROUP BY promoted_by ${campaignWindow(campaign)} ORDER BY day ASC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;

// [START campaign-dashboard.tier-queries]
// Ranked from sales because CustomerSortKeys has no spend key. OFFSET separates tiers.
export const tierRankQuery = ({size, skip = 0}) => `
  query AudienceRanking {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales GROUP BY customer_id SINCE -365d UNTIL today ORDER BY total_sales DESC LIMIT ${size}${skip > 0 ? ` OFFSET ${skip}` : ''}"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;

// A series rather than a total, to chart against the store-wide line.
export const tierSalesQuery = (campaign, dimension, tier) => `
  query CampaignAudienceSales {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders TIMESERIES day ${campaignWindow(campaign)} WHERE ${inGraphQLString(dimension)} = '${tier}' ORDER BY day ASC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.tier-queries]

// [START campaign-dashboard.order-touch-queries]
// One row per order with the day it landed on. `order_id` comes back numeric.
export const orderDaysQuery = (campaign) => `
  query CampaignOrders {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales GROUP BY order_id, day ${campaignWindow(campaign)} ORDER BY day ASC"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;

// Grouping orders by the touch they followed splits revenue across a campaign's sends.
export const touchSalesQuery = (campaign, dimension) => `
  query CampaignTouchSales {
    shopifyqlQuery(
      query: "FROM sales SHOW ${inGraphQLString(dimension)} AS touch, total_sales, orders GROUP BY touch ${campaignWindow(campaign)} ORDER BY total_sales DESC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.order-touch-queries]

// [START campaign-dashboard.creator-code-queries]
// `discount_code` is built in. Rolling codes up to one creator is the app's own job.
export const codeSalesQuery = (campaign, filter) => `
  query CampaignCodeSales {
    shopifyqlQuery(
      query: "FROM sales SHOW discount_code, total_sales, orders GROUP BY discount_code ${campaignWindow(campaign)} WHERE ${filter} ORDER BY total_sales DESC"
    ) {
      tableData {
        columns {
          name
          dataType
          displayName
        }
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.creator-code-queries]

// [START campaign-dashboard.audience-roster]
// Resolved when the audience changes. The record keeps the roster it stamped.
export const CUSTOMER_NAMES = `
  query AudienceNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer {
        id
        displayName
      }
    }
  }
`;
// [END campaign-dashboard.audience-roster]

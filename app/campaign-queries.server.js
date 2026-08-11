// Every GraphQL document this app sends. Campaign-dependent queries are builders,
// so a second campaign needs no second document.
import {campaignWindow} from './campaigns';
import {FUNNEL_METRICS, SEQUENCE_METRICS} from './channels';
import {insightWindow} from './insight';

// [START campaign-dashboard.shop-query]
// The store's timezone decides which day a dated write lands on, and App Events
// addresses the store by ID.
export const SHOP_QUERY = `
  query CampaignShop {
    shop {
      id
      ianaTimezone
    }
  }
`;
// [END campaign-dashboard.shop-query]

// [START campaign-dashboard.metafield-state]
// One app-data metafield holds every campaign. An AppInstallation owner is already
// isolated to this install, so the reserved `$app` namespace isn't needed here.
export const STATE_NAMESPACE = 'campaign_dashboard';
export const STATE_KEY = 'campaigns';

// Returns the app's own ID too, which is how a later read tells this app's markers
// from another app's without matching on the title.
export const STATE_QUERY = `
  query CampaignState {
    currentAppInstallation {
      id
      app {
        id
      }
      metafield(namespace: "${STATE_NAMESPACE}", key: "${STATE_KEY}") {
        id
        value
      }
    }
  }
`;

// One mutation for the campaign list, the promoted-product stamps, and the audience
// tags. The ownerId is what differs.
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
// ShopifyQL buckets a TIMESERIES by the shop's timezone rather than UTC, so the
// same query reads it.
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
// A factory, so two skipped panels don't share one rows array.
export const emptyTable = () => ({
  tableData: {columns: [], rows: []},
  parseErrors: [],
  unavailable: null,
});

// A dataset the shop can't reach fails the whole GraphQL request rather than
// returning parseErrors, and a parse error returns a null tableData. Normalize both.
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

// Only the fields you pass change, so raising a goal leaves the metric and filters
// alone.
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
// Shopify generates each target's `shopifyqlQuery` from its metric, dates, and
// filters, so measuring progress needs no query of your own.
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

// [START campaign-dashboard.target-progress]
// `shopifyqlQuery` is a plain field, so aliasing it measures every target in one
// request rather than one each.
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

// The generated query selects one metric, so its single row holds one value.
export function progressValue(result) {
  if (!result || result.parseErrors?.length) return null;
  const row = result.tableData?.rows?.[0];
  if (!row) return 0;
  return Number(Object.values(row)[0] ?? 0);
}

// Re-measuring one target before writing a permanent marker for it.
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
// A bundle and a plain product are different annotation types, and
// `hasVariantsThatRequiresComponents` is what says which one the app promoted.
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
// Every field is mutable and only the fields you pass change, so a marker written
// before the campaign ran can be rewritten with what happened.
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
// Hangs off Shop, and sorts by ID unless told otherwise. Filtering by window rather
// than by app is what keeps the sale or theme change that explains the numbers in
// view, and `createdByApp` says which markers are the app's own.
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
// These columns exist only because the extension declares the matching standard
// events, so the dataset's shape differs from shop to shop.
export const appEventsQuery = (campaign) => `
  query CampaignFunnel {
    shopifyqlQuery(
      query: "FROM app_events SHOW ${FUNNEL_METRICS.join(', ')} WHERE campaign_id = ${campaign.id} TIMESERIES day ${campaignWindow(campaign)} ORDER BY day ASC"
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
// Attribute dimensions reach back 30 days and a longer window fails outright, and
// SINCE -30d UNTIL today spans 31 days. Hence -29d.
export const sliceQuery = () => `
  query CampaignComparison {
    shopifyqlQuery(
      query: "FROM app_events SHOW emails_sent, emails_opened, sms_messages_sent GROUP BY campaign_id SINCE -29d UNTIL today ORDER BY emails_sent DESC"
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

// [START campaign-dashboard.cross-app-query]
// `app_name` is a property of the event rather than an attribute the app attaches,
// so it has no 30-day cap.
export const crossAppQuery = (campaign) => `
  query CampaignReachByApp {
    shopifyqlQuery(
      query: "FROM app_events SHOW emails_sent, sms_messages_sent, push_notifications_sent GROUP BY app_name ${campaignWindow(campaign)} ORDER BY emails_sent DESC"
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
// [END campaign-dashboard.cross-app-query]

// [START campaign-dashboard.sequence-query]
// A template belongs to one channel, so all three channels' metrics share one SHOW
// and each row fills only its own channel's columns.
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
// `recipient_status` separates a hard bounce, which is a dead address worth dropping
// from the list, from a soft one, which is temporary.
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

// [START campaign-dashboard.insight-query]
// TIMESERIES week counts as the first grouping, so OVERALL is what picks the top
// five once rather than again every week. ONLY drops the `Other` row, which would
// dwarf the five product lines.
export const insightQuery = (campaign) => `
  query CampaignInsight {
    shopifyqlQuery(
      query: "FROM sales SHOW gross_sales TIMESERIES week GROUP BY ONLY TOP 5 product_title OVERALL ${insightWindow(campaign)} ORDER BY week ASC"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;
// [END campaign-dashboard.insight-query]

// [START campaign-dashboard.metafield-capability]
// Eligibility depends on the owner type and the field type, so read `eligible`
// before offering the control.
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

// TOML can't set `analyticsQueryable` and a definition declared there is read-only
// through the GraphQL Admin API, so the app creates its own with the capability
// already on.
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

// No `id` field. It addresses the definition by key and owner type, falling back to
// the app-reserved namespace, and the update can't change any of the three.
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

// The namespace holds a double hyphen, so the dimension has to be quoted. `AS` is
// what names the column, or it comes back as the whole dotted expression.
export const promotedByQuery = (campaign, dimension) => `
  query CampaignPromotedSplit {
    shopifyqlQuery(
      query: "FROM sales SHOW ${dimension} AS promoted_by, total_sales, orders GROUP BY promoted_by ${campaignWindow(campaign)} ORDER BY total_sales DESC"
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
// Ranked from the sales dataset because CustomerSortKeys has no spend key. OFFSET is
// what keeps one tier from containing another, and both need the ORDER BY to be
// stable.
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

// A series rather than a total, because the panel charts it against the store-wide
// line.
export const tierSalesQuery = (campaign, dimension, tier) => `
  query CampaignAudienceSales {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders TIMESERIES day ${campaignWindow(campaign)} WHERE ${dimension} = '${tier}' ORDER BY day ASC"
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

// [START campaign-dashboard.audience-roster]
// GROUP BY customer_id returns IDs and no names.
export const rosterQuery = (campaign) => `
  query AudienceSpend {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders GROUP BY customer_id ${campaignWindow(campaign)} ORDER BY total_sales DESC LIMIT 50"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;

// Resolved when the audience changes rather than on every page load.
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

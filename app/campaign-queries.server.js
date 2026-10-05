// Every GraphQL document this app sends. Campaign-dependent queries are builders.
import {TIER_METAFIELD} from './audiences';
import {DIMENSION_NAMESPACE, campaignWindow, recentWindow} from './campaigns';
import {FUNNEL_METRICS, SEQUENCE_METRICS} from './channels';

// [START campaign-dashboard.shop-query]
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
// Analytics joins only non-reserved types, and only once the merchant turns it on for
// the type. The prefix keeps it clear of a type the merchant made.
export const CAMPAIGN_TYPE = 'campaign_dashboard_campaign';

// A campaign stores its QR code IDs as text. Each code's handle is its utm_campaign,
// and its title names it on the chart.
export const QR_CODE_HANDLES = `
  query QRCodeHandles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject {
        id
        handle
        title: field(key: "title") {
          value
        }
        liveOn: field(key: "live_on") {
          value
        }
      }
    }
  }
`;

// The highest ID ever handed out, on the app installation. A deleted campaign's ID stays spent.
export const ID_NAMESPACE = 'campaign_dashboard';
export const ID_KEY = 'last_campaign_id';

// `jsonValue` returns each field typed. Reference lists also resolve what they point at.
const CAMPAIGN_NODE = `
  id
  handle
  updatedAt
  fields {
    key
    jsonValue
  }
  products: field(key: "products") {
    references(first: 5) {
      nodes {
        ... on Product {
          id
          title
        }
      }
    }
  }
`;

// Returns this app's ID. `createdByApp` matches on it to find this app's annotations.
export const CAMPAIGNS_QUERY = `
  query CampaignList($type: String!, $after: String) {
    currentAppInstallation {
      id
      app {
        id
        title
      }
      metafield(namespace: "${ID_NAMESPACE}", key: "${ID_KEY}") {
        value
      }
    }
    metaobjects(type: $type, first: 250, after: $after) {
      nodes {
        ${CAMPAIGN_NODE}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const CAMPAIGN_BY_ID = `
  query CampaignById($id: ID!) {
    metaobject(id: $id) {
      ${CAMPAIGN_NODE}
    }
  }
`;

export const CAMPAIGN_VERSION = `
  query CampaignVersion($id: ID!) {
    metaobject(id: $id) {
      updatedAt
    }
  }
`;

export const CUSTOMER_TIER = `
  query CustomerTier($id: ID!) {
    customer(id: $id) {
      tier: metafield(namespace: "${DIMENSION_NAMESPACE}", key: "${TIER_METAFIELD.key}") {
        value
      }
    }
  }
`;

export const METAFIELDS_DELETE = `
  mutation DeleteCustomerTier($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// One mutation for the ID high-water mark, product stamps, and audience tags.
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
// TIMESERIES buckets by the shop's timezone.
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
// Built per panel. Two skipped panels would otherwise share a rows array.
export const emptyTable = () => ({
  tableData: {columns: [], rows: []},
  parseErrors: [],
  unavailable: null,
});

// An unreachable schema fails the whole request. A parse error nulls tableData.
// Either way the panel gets its reason in `unavailable`.
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
      unavailable: result?.parseErrors?.length
        ? result.parseErrors.join(' ')
        : null,
    };
  } catch (error) {
    return {...emptyTable(), unavailable: error.message};
  }
}
// [END campaign-dashboard.optional-query]

// [START campaign-dashboard.supported-query]
// Targets and annotations are newer than the sales query. On an older API version the
// whole request fails. An empty body leaves the other panels rendering.
export async function runIfSupported(admin, query) {
  try {
    return await (await admin.graphql(query)).json();
  } catch {
    return {data: null};
  }
}
// [END campaign-dashboard.supported-query]

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
// By ID, because a QR code's target starts on the day the code goes live.
const CAMPAIGN_TARGETS = `
  query CampaignTargets($ids: [ID!]!) {
    targets: nodes(ids: $ids) {
      ... on AnalyticsTarget {
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

export async function readTargets(admin, campaign) {
  const ids = Object.values(campaign.targets ?? {}).filter(
    (id) => typeof id === 'string' && id.startsWith('gid://shopify/AnalyticsTarget/'),
  );
  return (await admin.graphql(CAMPAIGN_TARGETS, {variables: {ids}})).json();
}

// A deleted target comes back as null.
export const targetNodes = (body) => (body.data?.targets ?? []).filter(Boolean);

// [END campaign-dashboard.target-read]

// [START campaign-dashboard.all-targets-read]
// Every campaign's recorded IDs in one read. A paged `analyticsTargets` list drops
// targets past the first page once QR codes add their own.
export async function readAllTargets(admin, campaigns) {
  const targets = Object.fromEntries(
    campaigns.flatMap((campaign) =>
      Object.entries(campaign.targets ?? {}).map(([key, id]) => [`${campaign.id}:${key}`, id]),
    ),
  );
  try {
    return await readTargets(admin, {targets});
  } catch {
    return {data: null};
  }
}
// [END campaign-dashboard.all-targets-read]

// [START campaign-dashboard.target-progress]
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

// A deleted annotation comes back as null. `createdByApp` guards against an ID that
// someone edited into the record.
export const RECORDED_ANNOTATIONS = `
  query RecordedAnnotations($ids: [ID!]!) {
    annotations: nodes(ids: $ids) {
      ... on AnalyticsAnnotation {
        id
        createdByApp {
          id
        }
      }
    }
  }
`;
// [END campaign-dashboard.annotation-delete]

// [START campaign-dashboard.annotation-read]
// A window holding more annotations than the page size continues from `endCursor`.
export const annotationsQuery = (campaign, after = null) => `
  query CampaignAnnotations {
    currentAppInstallation {
      app {
        id
      }
    }
    shop {
      analyticsAnnotations(
        first: 50
        ${after ? `after: "${after}"` : ''}
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
// Campaign IDs repeat across apps. Matching `app_name` keeps another app's
// sends out of this funnel. App titles can hold an apostrophe, and a doubled
// quote keeps the ShopifyQL string valid. A double quote or backslash would end the
// GraphQL string around it, and JSON escaping covers both.
const appNameValue = (appName) =>
  JSON.stringify(appName.replaceAll("'", "''")).slice(1, -1);

export const appEventsQuery = (campaign, appName) => `
  query CampaignFunnel {
    shopifyqlQuery(
      query: "FROM app_events SHOW ${FUNNEL_METRICS.join(', ')} WHERE campaign_id = ${campaign.id} AND app_name = '${appNameValue(appName)}' TIMESERIES day ${recentWindow(campaign)} ORDER BY day ASC"
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
// SINCE -30d UNTIL today spans 31 days, one past the limit.
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
export const sequenceQuery = (campaign, appName) => `
  query CampaignSequence {
    shopifyqlQuery(
      query: "FROM app_events SHOW ${SEQUENCE_METRICS.join(', ')} WHERE campaign_id = ${campaign.id} AND app_name = '${appNameValue(appName)}' GROUP BY template_id SINCE -29d UNTIL today ORDER BY template_id ASC"
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
export const bounceQuery = (campaign, appName) => `
  query CampaignBounces {
    shopifyqlQuery(
      query: "FROM app_events SHOW emails_bounced WHERE campaign_id = ${campaign.id} AND app_name = '${appNameValue(appName)}' GROUP BY recipient_status SINCE -29d UNTIL today ORDER BY emails_bounced DESC"
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
export const DEFINITION_QUERY = `
  query AppMetafieldDefinitions($namespace: String!) {
    products: metafieldDefinitions(
      first: 1
      ownerType: PRODUCT
      namespace: $namespace
      key: "campaign"
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

// A reference dimension parses once the merchant turns on analytics for the
// Campaign type. Until then, naming it fails with `Metafield Column Not Found`.
// The probe reads one day and needs no stamped product to succeed.
export const dimensionProbeQuery = (dimension) => `
  query CampaignDimensionProbe {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales GROUP BY ${inGraphQLString(dimension)} SINCE -1d UNTIL today LIMIT 1"
    ) {
      parseErrors
    }
  }
`;

// `AS` names the column. Without it the column is the whole dotted expression. A day
// bucket splits the window into the campaign's products and everything else.
export const promotedByQuery = (campaign, dimension) => `
  query CampaignPromotedSplit {
    shopifyqlQuery(
      query: "FROM sales SHOW ${inGraphQLString(dimension)} AS promoted_by, total_sales GROUP BY promoted_by TIMESERIES day ${campaignWindow(campaign)} ORDER BY day ASC"
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

// Each earlier member's current stamp. A later campaign in another tier may hold it.
export const CUSTOMER_TIERS = `
  query CustomerTiers($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer {
        id
        tier: metafield(namespace: "${DIMENSION_NAMESPACE}", key: "${TIER_METAFIELD.key}") {
          value
        }
      }
    }
  }
`;

// [START campaign-dashboard.tier-queries]
export const tierRankQuery = ({size, skip = 0}) => `
  query AudienceRanking {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales WHERE customer_id IS NOT NULL GROUP BY customer_id SINCE -365d UNTIL today ORDER BY total_sales DESC LIMIT ${size}${skip > 0 ? ` OFFSET ${skip}` : ''}"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;

export const tierSalesQuery = (campaign, dimension, tier) => `
  query CampaignAudienceSales {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales, orders WHERE ${inGraphQLString(dimension)} = '${tier}' TIMESERIES day ${campaignWindow(campaign)} ORDER BY day ASC"
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
// `order_id` comes back numeric. Paging with `LIMIT` and `OFFSET` keeps a long
// campaign's close from loading every order row at once.
export const ORDER_PAGE_SIZE = 250;

export const orderDaysQuery = (campaign, offset) => `
  query CampaignOrders {
    shopifyqlQuery(
      query: "FROM sales SHOW total_sales GROUP BY order_id, day ${campaignWindow(campaign)} ORDER BY day ASC, order_id ASC LIMIT ${ORDER_PAGE_SIZE} OFFSET ${offset}"
    ) {
      tableData {
        rows
      }
      parseErrors
    }
  }
`;

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
// `discount_code` is built in. Rolling codes up to one creator is the app's job.
export const codeSalesQuery = (campaign, filter) => `
  query CampaignCodeSales {
    shopifyqlQuery(
      query: "FROM sales SHOW discount_code, total_sales, orders WHERE ${filter} GROUP BY discount_code ${campaignWindow(campaign)} ORDER BY total_sales DESC"
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

// [START campaign-dashboard.qr-sales-queries]
// The QR app stamps every scan with utm_medium=qr and the code's handle as
// utm_campaign. The store's attribution model does the rest.
export const qrSalesQuery = (campaign, filter) => `
  query CampaignQRSales {
    shopifyqlQuery(
      query: "FROM campaign_sales SHOW utm_campaign, campaign_last_non_direct_click_total_sales, campaign_last_non_direct_click_order_count WHERE utm_medium = 'qr' AND ${filter} GROUP BY utm_campaign ${campaignWindow(campaign)} ORDER BY campaign_last_non_direct_click_total_sales DESC"
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
// [END campaign-dashboard.qr-sales-queries]

// [START campaign-dashboard.campaign-documents]
export const CAMPAIGN_DEFINITION_QUERY = `
  query CampaignDefinition($type: String!) {
    campaign: metaobjectDefinitionByType(type: $type) {
      id
      fieldDefinitions {
        key
      }
    }
  }
`;

export const CAMPAIGN_FIELDS_ADD = `
  mutation AddCampaignFields($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const CAMPAIGN_DEFINITION_CREATE = `
  mutation CreateCampaignDefinition($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const CAMPAIGN_CREATE = `
  mutation CreateCampaign($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        ${CAMPAIGN_NODE}
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// Creates the entry when the handle is new. Seeds rely on it to stay single.
export const CAMPAIGN_UPSERT = `
  mutation UpsertCampaign($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject {
        ${CAMPAIGN_NODE}
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// Writes only the fields it receives. The rest keep their values.
export const CAMPAIGN_UPDATE = `
  mutation UpdateCampaign($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject {
        ${CAMPAIGN_NODE}
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const CAMPAIGN_DELETE = `
  mutation DeleteCampaign($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
        code
      }
    }
  }
`;
// [END campaign-dashboard.campaign-documents]

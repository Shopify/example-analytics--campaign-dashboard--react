import {
  ANNOTATION_CREATE,
  ANNOTATION_DELETE,
  ANNOTATION_UPDATE,
  BUNDLE_QUERY,
  CUSTOMER_NAMES,
  METAFIELDS_SET,
  TARGET_CREATE,
  TARGET_UPDATE,
  annotationsQuery,
  appEventsQuery,
  bounceQuery,
  measureQuery,
  orderDaysQuery,
  progressValue,
  runOptional,
  tierRankQuery,
} from './campaign-queries.server';
import {
  rememberMarkers,
  transportErrors,
  updateCampaign,
} from './campaigns.server';
import {detectIncident} from './campaign-report.server';
import {
  DIMENSION_NAMESPACE,
  campaignMarks,
  lastTouch,
  promotedFilter,
  touchMarks,
} from './campaigns';
import {AUDIENCE_TIERS, TIER_METAFIELD, isTargetedTier, tierLabel} from './audiences';

// A skipped target and a rejected one both have no ID. The errors say which.
const NO_TARGET = {id: null, userErrors: []};

// [START campaign-dashboard.store-target]
// Unfiltered, which measures the whole store over the campaign's window. Metric, dates,
// and filters identify a target. Creating this twice is a user error.
async function createTarget(admin, input) {
  const body = await (
    await admin.graphql(TARGET_CREATE, {variables: {input}})
  ).json();
  const created = body.data?.analyticsTargetCreate;
  return {
    id: created?.analyticsTarget?.id ?? null,
    userErrors: [...transportErrors(body), ...(created?.userErrors ?? [])],
  };
}

export const createStoreTarget = (admin, campaign) =>
  createTarget(admin, {
    name: `${campaign.title}: store-wide sales`,
    metric: 'total_sales',
    expectedValue: campaign.revenueTarget,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
  });
// [END campaign-dashboard.store-target]

// [START campaign-dashboard.product-target]
// The filter is a ShopifyQL predicate. This one selects what the campaign advertised.
export async function createProductTarget(admin, campaign) {
  const filters = promotedFilter(campaign);
  if (!filters) return NO_TARGET;

  return createTarget(admin, {
    name: `${campaign.title}: promoted products`,
    metric: 'total_sales',
    expectedValue: campaign.productTarget,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    filters,
  });
}
// [END campaign-dashboard.product-target]

// [START campaign-dashboard.audience-target]
// The same metric filtered on a dimension the app owns, with the reserved namespace
// quoted in full. Skipped until the definition is queryable.
export async function createAudienceTarget(admin, campaign, definition) {
  if (!isTargetedTier(campaign.audience)) return NO_TARGET;
  if (!definition.enabled) return NO_TARGET;

  return createTarget(admin, {
    name: `${campaign.title}: ${tierLabel(campaign.audience)}`,
    metric: 'total_sales',
    expectedValue: campaign.audienceTarget,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    filters: `${definition.dimension} = '${campaign.audience}'`,
  });
}
// [END campaign-dashboard.audience-target]

// [START campaign-dashboard.raise-target]
// Round the next target up from what the campaign earned, to a whole increment.
export async function raiseTarget(admin, target) {
  const actual = Number(target.actual ?? 0);
  const step = Math.max(1000, 10 ** (Math.floor(Math.log10(actual)) - 1));
  const raised = String(Math.ceil(actual / step) * step);

  const body = await (
    await admin.graphql(TARGET_UPDATE, {
      variables: {id: target.id, input: {expectedValue: raised}},
    })
  ).json();
  return [
    ...transportErrors(body),
    ...(body.data?.analyticsTargetUpdate?.userErrors ?? []),
  ];
}
// [END campaign-dashboard.raise-target]

// The start-date query returns the targets the user set alongside this app's. A form can
// name any ID it returned. Match against the recorded ones before writing.
export function recordedTarget(campaign, body, id) {
  const recorded = new Set(Object.values(campaign.targets ?? {}));
  return (body.data?.analyticsTargets?.nodes ?? []).find(
    (node) => node.id === String(id) && recorded.has(node.id),
  );
}

// [START campaign-dashboard.bundle-mark]
// A bundle needs `bundle_launch`. Only the store's data knows which it is.
const PLAIN_LAUNCH = {type: 'product_launch', note: ''};

async function resolveLaunchMark(admin, campaign) {
  const ids = campaign.products.map((product) => product.id);
  if (ids.length === 0) return PLAIN_LAUNCH;

  const body = await (
    await admin.graphql(BUNDLE_QUERY, {variables: {ids}})
  ).json();
  const bundles = (body.data?.nodes ?? []).filter(
    (node) => node?.hasVariantsThatRequiresComponents,
  );
  if (bundles.length === 0) return PLAIN_LAUNCH;

  return {
    type: 'bundle_launch',
    note: ` Sold as a bundle. Sales report against its components.`,
  };
}
// [END campaign-dashboard.bundle-mark]

// [START campaign-dashboard.clear-marks]
// Only this campaign's annotations. Another campaign over the same days has
// marks in this list too. Reading the store first also skips IDs already gone.
async function clearOwnMarks(admin, campaign, appId, keys) {
  const recorded = new Set(
    Object.entries(campaign.markers ?? {})
      .filter(([key]) => keys.has(key))
      .map(([, id]) => id),
  );
  const body = await (await admin.graphql(annotationsQuery(campaign))).json();
  const failed = transportErrors(body);
  if (failed.length) return failed;

  const nodes = body.data?.shop?.analyticsAnnotations?.nodes ?? [];
  const problems = [];

  for (const annotation of nodes) {
    if (annotation.createdByApp?.id !== appId) continue;
    if (!recorded.has(annotation.id)) continue;
    const deleted = await (
      await admin.graphql(ANNOTATION_DELETE, {variables: {id: annotation.id}})
    ).json();
    problems.push(...(deleted.data?.analyticsAnnotationDelete?.userErrors ?? []));
  }
  return problems;
}
// [END campaign-dashboard.clear-marks]

// [START campaign-dashboard.write-marks]
// Clear before writing, which makes launching and rewriting the same operation.
// Each ID persists as it lands. A retry or a cancel can then finish a partial write.
export async function writeMarks(admin, campaign, appId, markedAt) {
  // Milestones and incidents are recorded under separate keys and each marks a day
  // that happened. A rewrite of the base marks keeps them.
  const marks = campaignMarks(campaign);
  const keys = new Set(marks.map((mark) => mark.key));
  const stale = await clearOwnMarks(admin, campaign, appId, keys);
  if (stale.length) {
    return {markers: {}, problems: stale.map((error) => error.message)};
  }

  const launch = await resolveLaunchMark(admin, campaign);
  const markers = Object.fromEntries(
    Object.entries(campaign.markers ?? {}).filter(([key]) => !keys.has(key)),
  );
  for (const mark of marks) {
    const isLaunch = mark.key === 'launch';
    const body = await (
      await admin.graphql(ANNOTATION_CREATE, {
        variables: {
          input: {
            startedAt: markedAt(mark.date),
            // Omitted `endedAt` is a moment. Explicit null is an unfinished span.
            ...(mark.ranged ? {endedAt: null} : {}),
            type: isLaunch ? launch.type : mark.type,
            title: mark.title,
            description: isLaunch
              ? `${mark.description}${launch.note}`
              : mark.description,
          },
        },
      })
    ).json();
    const created = body.data?.analyticsAnnotationCreate;
    const errors = [...transportErrors(body), ...(created?.userErrors ?? [])];
    if (errors.length) {
      return {markers, problems: errors.map((error) => error.message)};
    }
    if (created?.analyticsAnnotation?.id) {
      markers[mark.key] = created.analyticsAnnotation.id;
      await rememberMarkers(admin, campaign.id, {
        [mark.key]: created.analyticsAnnotation.id,
      });
    }
  }
  return {markers, problems: []};
}
// [END campaign-dashboard.write-marks]

// [START campaign-dashboard.product-metafield]
// Stamp each promoted product with the campaign that pushed it. It reads back as
// `products.metafields."campaign_dashboard".promoted_by`.
export async function stampProducts(admin, campaign) {
  const metafields = campaign.products.map((product) => ({
    ownerId: product.id,
    namespace: DIMENSION_NAMESPACE,
    key: 'promoted_by',
    type: 'single_line_text_field',
    value: campaign.title,
  }));

  // `metafieldsSet` takes 25 at a time, and a campaign can promote more.
  const userErrors = [];
  for (let start = 0; start < metafields.length; start += 25) {
    const batch = await (
      await admin.graphql(METAFIELDS_SET, {
        variables: {metafields: metafields.slice(start, start + 25)},
      })
    ).json();
    userErrors.push(
      ...transportErrors(batch),
      ...(batch.data?.metafieldsSet?.userErrors ?? []),
    );
  }
  return userErrors;
}
// [END campaign-dashboard.product-metafield]

// [START campaign-dashboard.stamp-tier]
// The tier written onto the customers themselves. The roster is saved on the record
// too, because the metafield holds only the tier's name.
export async function stampTier(admin, campaign) {
  const tier = AUDIENCE_TIERS.find((entry) => entry.value === campaign.audience);
  if (!tier?.size) return {members: [], userErrors: []};

  const body = await (await admin.graphql(tierRankQuery(tier))).json();
  // A failed rank read finds no customers. Returning no errors would read as a tier
  // with nobody in it.
  const unranked = transportErrors(body);
  if (unranked.length) return {members: [], userErrors: unranked};

  // GROUP BY returns a numeric ID. Every mutation below wants a GID.
  const ids = (body.data?.shopifyqlQuery?.tableData?.rows ?? [])
    .map((row) => row.customer_id)
    .filter(Boolean)
    .map((id) => `gid://shopify/Customer/${id}`);
  if (ids.length === 0) return {members: [], userErrors: []};

  const stamped = await (
    await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: ids.map((id) => ({
          ownerId: id,
          namespace: DIMENSION_NAMESPACE,
          key: TIER_METAFIELD.key,
          type: 'single_line_text_field',
          value: campaign.audience,
        })),
      },
    })
  ).json();

  const names = await (
    await admin.graphql(CUSTOMER_NAMES, {variables: {ids}})
  ).json();
  return {
    members: (names.data?.nodes ?? []).filter(Boolean).map((node) => ({
      id: node.id,
      displayName: node.displayName,
    })),
    userErrors: [
      ...transportErrors(stamped),
      ...transportErrors(names),
      ...(stamped.data?.metafieldsSet?.userErrors ?? []),
    ],
  };
}
// [END campaign-dashboard.stamp-tier]

// [START campaign-dashboard.stamp-orders]
// Which send an order followed. Only the app knows what it sent.
export async function stampOrders(admin, campaign) {
  const body = await (await admin.graphql(orderDaysQuery(campaign))).json();
  const unread = transportErrors(body);
  if (unread.length) return unread;

  const touches = touchMarks(campaign);
  const metafields = (body.data?.shopifyqlQuery?.tableData?.rows ?? [])
    .map((row) => ({id: row.order_id, touch: lastTouch(touches, row.day)}))
    .filter((order) => order.id && order.touch)
    .map((order) => ({
      ownerId: `gid://shopify/Order/${order.id}`,
      namespace: DIMENSION_NAMESPACE,
      key: 'campaign_touch',
      type: 'single_line_text_field',
      value: order.touch,
    }));

  // `metafieldsSet` takes 25 at a time, and an order count has no cap.
  const userErrors = [];
  for (let start = 0; start < metafields.length; start += 25) {
    const batch = await (
      await admin.graphql(METAFIELDS_SET, {
        variables: {metafields: metafields.slice(start, start + 25)},
      })
    ).json();
    userErrors.push(
      ...transportErrors(batch),
      ...(batch.data?.metafieldsSet?.userErrors ?? []),
    );
  }
  return userErrors;
}
// [END campaign-dashboard.stamp-orders]

// Editable until launch. The target filters on these IDs and the annotation uses the
// titles.
export const setProducts = (admin, campaign, products) =>
  updateCampaign(admin, campaign.id, {products});

// Launch is what turns an amount into a target, and it rejects a zero. Editable
// until then, or adding products locks a campaign out of launching.
export const setTargetAmounts = (admin, campaign, amounts) =>
  updateCampaign(admin, campaign.id, amounts);

// [START campaign-dashboard.audience-edit]
// Moves both the tier on customers and a target's filter. Planned campaigns only.
export const setAudience = (admin, campaign, audience) =>
  updateCampaign(admin, campaign.id, {audience});
// [END campaign-dashboard.audience-edit]

// [START campaign-dashboard.close-with-outcome]
// Closing moves `endedAt` from null to the last day and puts the result in the title.
export async function closeCampaign(admin, campaign, text, endedAt) {
  const id = campaign.markers?.campaign;
  // No span means nothing to close. Returning no errors would read as success.
  if (!id) {
    return [{message: "This campaign has no annotation to close."}];
  }

  const body = await (
    await admin.graphql(ANNOTATION_UPDATE, {
      variables: {id, input: {endedAt, title: text.title, description: text.description}},
    })
  ).json();
  return [
    ...transportErrors(body),
    ...(body.data?.analyticsAnnotationUpdate?.userErrors ?? []),
  ];
}
// [END campaign-dashboard.close-with-outcome]

// [START campaign-dashboard.milestone]
// A milestone is one moment, which leaves `endedAt` off. Re-measured on the server.
export async function markMilestone(admin, target, markedAt, money) {
  const body = await (
    await admin.graphql(measureQuery(target.shopifyqlQuery))
  ).json();
  const actual = progressValue(body.data?.shopifyqlQuery);
  if (actual === null || actual < Number(target.expectedValue)) {
    return {userErrors: [{message: 'That target has not been reached yet.'}]};
  }

  const created = await (
    await admin.graphql(ANNOTATION_CREATE, {
      variables: {
        input: {
          startedAt: markedAt,
          type: 'revenue_milestone',
          title: `${target.name} reached`,
          description: `${target.name} passed its target of ${money(
            Number(target.expectedValue),
          )} on this day, at ${money(actual)}.`,
        },
      },
    })
  ).json();

  return created.data?.analyticsAnnotationCreate ?? {userErrors: []};
}
// [END campaign-dashboard.milestone]

// [START campaign-dashboard.record-mark]
// Keyed on the record, which is what lets an annotation be rewritten and a cancel find it.
// Milestones and incidents repeat. Their keys hold what makes them distinct.
export const recordMark = (admin, campaign, key, id) =>
  id ? rememberMarkers(admin, campaign.id, {[key]: id}) : null;
// [END campaign-dashboard.record-mark]

// [START campaign-dashboard.flag-incident]
// No bounce type in the vocabulary. Written as `other` with the reason in the text.
export async function flagIncident(admin, campaign, markedAt) {
  const [funnel, bounces] = await Promise.all([
    runOptional(admin, appEventsQuery(campaign)),
    runOptional(admin, bounceQuery(campaign)),
  ]);

  const incident = detectIncident(campaign, funnel, bounces);
  if (!incident) {
    return {userErrors: [{message: 'Bounces are within the alert threshold.'}]};
  }

  const body = await (
    await admin.graphql(ANNOTATION_CREATE, {
      variables: {
        input: {
          startedAt: markedAt,
          type: 'other',
          title: incident.title,
          description: incident.description,
        },
      },
    })
  ).json();

  return body.data?.analyticsAnnotationCreate ?? {userErrors: []};
}
// [END campaign-dashboard.flag-incident]

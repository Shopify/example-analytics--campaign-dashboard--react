import {
  ANNOTATION_CREATE,
  ANNOTATION_DELETE,
  ANNOTATION_UPDATE,
  BUNDLE_QUERY,
  HOLDERS_PAGE_SIZE,
  METAFIELDS_DELETE,
  METAFIELDS_SET,
  ORDER_PAGE_SIZE,
  RECORDED_ANNOTATIONS,
  TARGET_CREATE,
  TARGET_UPDATE,
  appEventsQuery,
  bounceQuery,
  measureQuery,
  orderDaysQuery,
  progressValue,
  readTargets,
  runOptional,
  targetNodes,
  tierHoldersQuery,
  tierRankQuery,
} from './campaign-queries.server';
import {
  rememberMarkers,
  transportErrors,
  updateCampaign,
} from './campaigns.server';
import {detectIncident} from './campaign-report.server';
import {startBulkMetafieldsSet} from './bulk-stamp.server';
import {queryShopifyQL, shopifyqlErrors} from './shopifyql.server';
import {
  DIMENSION_NAMESPACE,
  QR_MARK_PREFIX,
  campaignMarks,
  clamp,
  isPositiveAmount,
  lastTouch,
  promotedFilter,
  qrHandles,
  qrLiveOn,
  qrTitle,
  targetEnd,
  touchMarks,
} from './campaigns';
import {AUDIENCE_TIERS, TIER_METAFIELD, isTargetedTier, tierLabel} from './audiences';

// A skipped target and a rejected one both have no ID. The errors say which.
const NO_TARGET = {id: null, userErrors: []};

// [START campaign-dashboard.store-target]
// Metric, dates, and filters identify a target. A duplicate returns TAKEN with the
// existing target, and that target belongs to someone else. Keep no ID beside an error.
async function createTarget(admin, input, measures) {
  const body = await (
    await admin.graphql(TARGET_CREATE, {
      variables: {input: {...input, endDate: targetEnd(input.startDate, input.endDate)}},
    })
  ).json();
  const created = body.data?.analyticsTargetCreate;
  const userErrors = [
    ...transportErrors(body),
    ...(created?.userErrors ?? []).map((error) =>
      error.code === 'TAKEN'
        ? {...error, message: `This campaign has no ${measures} target. Another target on the same dates already measures the same sales, and Shopify identifies a target by its metric, dates, and filters.`}
        : error,
    ),
  ];
  return {
    id: userErrors.length ? null : created?.analyticsTarget?.id ?? null,
    userErrors,
  };
}

// A blank amount is no target. Activation skips it.
export const createStoreTarget = (admin, campaign) =>
  isPositiveAmount(campaign.revenueTarget)
    ? createTarget(admin, {
        name: `${campaign.title}: store-wide sales`,
        metric: 'total_sales',
        expectedValue: campaign.revenueTarget,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
      }, 'store-wide sales')
    : NO_TARGET;
// [END campaign-dashboard.store-target]

// [START campaign-dashboard.product-target]
export async function createProductTarget(admin, campaign) {
  const filters = promotedFilter(campaign);
  if (!filters || !isPositiveAmount(campaign.productTarget)) return NO_TARGET;

  return createTarget(admin, {
    name: `${campaign.title}: promoted products`,
    metric: 'total_sales',
    expectedValue: campaign.productTarget,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    filters,
  }, 'promoted products');
}
// [END campaign-dashboard.product-target]

// [START campaign-dashboard.audience-target]
// Skipped until the definition is queryable.
export async function createAudienceTarget(admin, campaign, definition) {
  if (!isTargetedTier(campaign.audience)) return NO_TARGET;
  if (!definition.enabled) return NO_TARGET;
  if (!isPositiveAmount(campaign.audienceTarget)) return NO_TARGET;

  return createTarget(admin, {
    name: `${campaign.title}: ${tierLabel(campaign.audience)} segment`,
    metric: 'total_sales',
    expectedValue: campaign.audienceTarget,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    filters: `${definition.dimension} = '${campaign.audience}'`,
  }, `${tierLabel(campaign.audience)} segment`);
}
// [END campaign-dashboard.audience-target]

// [START campaign-dashboard.qr-target]
// One target per code, from its live day. The attribution metric credits an order to the
// code's utm_campaign, the handle the QR app wrote into the scan URL.
export async function createQrTargets(admin, campaign) {
  const targets = {};
  const userErrors = [];
  if (!isPositiveAmount(campaign.qrTarget)) return {targets, userErrors};

  for (const handle of qrHandles(campaign)) {
    const result = await createTarget(admin, {
      name: `${campaign.title}: ${qrTitle(campaign, handle)} QR code`,
      metric: 'campaign_last_non_direct_click_total_sales',
      expectedValue: campaign.qrTarget,
      startDate: qrLiveOn(campaign, handle),
      endDate: campaign.endDate,
      filters: `utm_campaign = '${handle}'`,
    }, `${qrTitle(campaign, handle)} QR code`);
    if (result.id) targets[`${QR_MARK_PREFIX}${handle}`] = result.id;
    userErrors.push(...result.userErrors);
  }
  return {targets, userErrors};
}
// [END campaign-dashboard.qr-target]

// [START campaign-dashboard.raise-target]
export async function raiseTarget(admin, target) {
  const actual = Number(target.actual ?? 0);
  const step = Math.max(1000, 10 ** (Math.floor(Math.log10(actual)) - 1));
  // The next increment above the amount. An exact multiple has to move too.
  const raised = String((Math.floor(actual / step) + 1) * step);

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

// [START campaign-dashboard.end-targets]
// An early close moves each target's end to the close day. Shopify rebuilds each query.
// A code not yet live keeps a one-day target. A target has to end after it starts.
export async function endTargetsOn(admin, campaign, day) {
  const read = await readTargets(admin, campaign);
  const problems = [...transportErrors(read)];
  const warnings = [];
  for (const target of problems.length ? [] : targetNodes(read)) {
    const endDate = targetEnd(target.startDate, day);
    const body = await (
      await admin.graphql(TARGET_UPDATE, {
        variables: {id: target.id, input: {endDate}},
      })
    ).json();
    const failed = transportErrors(body);
    const userErrors = body.data?.analyticsTargetUpdate?.userErrors ?? [];
    // TAKEN means another target already has this metric, start, end, and filters.
    // The target keeps its end date, and the close goes on without it.
    const taken = userErrors.length && userErrors.every((error) => error.code === 'TAKEN');
    if (!failed.length && taken) {
      warnings.push({
        message: `${target.name} keeps its end date of ${target.endDate}. Another target already measures the same sales from ${target.startDate} to ${endDate}.`,
      });
      continue;
    }
    problems.push(...failed, ...userErrors);
  }
  return {problems, warnings};
}
// [END campaign-dashboard.end-targets]

// [START campaign-dashboard.own-targets]
// Every name above ends in what the target measures. The title in front can change.
const TARGET_ENDINGS = [': store-wide sales', ': promoted products', ' segment', ' QR code'];
export const isOwnTarget = (target) =>
  target.name?.includes(': ') && TARGET_ENDINGS.some((ending) => target.name.endsWith(ending));
// [END campaign-dashboard.own-targets]

// A form can name any target ID. Match against the recorded ones before writing.
export function recordedTarget(campaign, body, id) {
  const recorded = new Set(Object.values(campaign.targets ?? {}));
  return targetNodes(body).find(
    (node) => node.id === String(id) && recorded.has(node.id),
  );
}

// [START campaign-dashboard.bundle-mark]
// A bundle needs `bundle_launch`.
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
// By recorded ID. A date-window search misses marks after a date edit, and the rewrite
// doubles them. Each problem names the annotation it left. A failed read names none.
export async function clearOwnMarks(admin, ids, appId) {
  const recorded = ids.filter(
    (id) => typeof id === 'string' && id.startsWith('gid://shopify/AnalyticsAnnotation/'),
  );
  if (!recorded.length) return [];
  const body = await (
    await admin.graphql(RECORDED_ANNOTATIONS, {variables: {ids: recorded}})
  ).json();
  const failed = transportErrors(body);
  if (failed.length) return failed.map((error) => ({...error, id: null}));

  const problems = [];
  for (const annotation of body.data?.annotations ?? []) {
    if (annotation?.createdByApp?.id !== appId) continue;
    const deleted = await (
      await admin.graphql(ANNOTATION_DELETE, {variables: {id: annotation.id}})
    ).json();
    const errors = [
      ...transportErrors(deleted),
      ...(deleted.data?.analyticsAnnotationDelete?.userErrors ?? []),
    ];
    problems.push(...errors.map((error) => ({...error, id: annotation.id})));
  }
  return problems;
}
// [END campaign-dashboard.clear-marks]

// [START campaign-dashboard.write-marks]
// Milestones and incidents each mark a day that happened. Every other key holds a mark
// the campaign's fields produced.
export const isPlannedMark = (key) =>
  !key.startsWith('milestone:') && !key.startsWith('incident:');

// Clear before writing. Activating and rewriting become the same operation.
// Each ID persists as it lands. A retry or a cancel can then finish a partial write.
export async function writeMarks(admin, campaign, appId, markedAt) {
  // A rewrite keeps milestones and incidents. It clears every planned mark, including
  // one whose field changed since the last write, like a reassigned code or removed products.
  const marks = campaignMarks(campaign);
  const keys = new Set([
    ...marks.map((mark) => mark.key),
    ...Object.keys(campaign.markers ?? {}).filter(isPlannedMark),
  ]);
  const stale = await clearOwnMarks(
    admin,
    Object.entries(campaign.markers ?? {})
      .filter(([key]) => keys.has(key))
      .map(([, id]) => id),
    appId,
  );
  if (stale.length) {
    return {markers: campaign.markers ?? {}, problems: stale.map((error) => error.message)};
  }

  // Save the pruned record first. A create that fails next leaves no deleted IDs behind.
  const markers = Object.fromEntries(
    Object.entries(campaign.markers ?? {}).filter(([key]) => !keys.has(key)),
  );
  const pruned = await updateCampaign(admin, campaign, {markers});
  if (pruned.userErrors.length) {
    return {markers, problems: pruned.userErrors.map((error) => error.message)};
  }

  const launch = await resolveLaunchMark(admin, campaign);
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
    const id = created?.analyticsAnnotation?.id;
    if (id) {
      const saved = await rememberMarkers(campaign, {[mark.key]: id});
      // An ID the record doesn't hold is an annotation nothing can find again.
      if (saved.userErrors.length) {
        const orphaned = await clearOwnMarks(admin, [id], appId);
        return {
          markers,
          problems: [...saved.userErrors, ...orphaned].map((error) => error.message),
        };
      }
      markers[mark.key] = id;
    }
  }
  return {markers, problems: []};
}
// [END campaign-dashboard.write-marks]

// [START campaign-dashboard.product-metafield]
export async function stampProducts(admin, campaign) {
  // The entry's GID. Analytics groups by the entry's fields of analytics-compatible types,
  // such as text, numbers, and dates.
  const metafields = campaign.products.map((product) => ({
    ownerId: product.id,
    namespace: DIMENSION_NAMESPACE,
    key: 'campaign',
    type: 'metaobject_reference',
    value: campaign.gid,
  }));

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
// GROUP BY customer_id returns a numeric ID. Every mutation below wants a GID.
async function customerIds(admin, query) {
  const body = await queryShopifyQL(admin, query);
  const userErrors = shopifyqlErrors(body);
  const rows = body.data?.shopifyqlQuery?.tableData?.rows ?? [];
  const ids = rows
    .map((row) => row.customer_id)
    .filter(Boolean)
    .map((id) => `gid://shopify/Customer/${id}`);
  return {ids: userErrors.length ? [] : ids, rowCount: rows.length, userErrors};
}

// A tier can outgrow one page. A page shorter than the limit is the last one. The cap
// stops a query that keeps returning full pages.
const MAX_PAGES = 200;
const tooManyPages = {message: `Stopped after ${MAX_PAGES} pages. Narrow the campaign and try again.`};

async function tierHolders(admin, dimension, tier) {
  const ids = [];
  for (let offset = 0; offset < MAX_PAGES * HOLDERS_PAGE_SIZE; offset += HOLDERS_PAGE_SIZE) {
    const page = await customerIds(admin, tierHoldersQuery(dimension, tier, offset));
    if (page.userErrors.length) return {ids: [], userErrors: page.userErrors};
    ids.push(...page.ids);
    if (page.rowCount < HOLDERS_PAGE_SIZE) return {ids, userErrors: []};
  }
  return {ids: [], userErrors: [tooManyPages]};
}

// A re-rank moves customers out of the tier. ShopifyQL finds who holds the tier now,
// and the stamps come off everyone outside the new rank.
export async function stampTier(admin, campaign, definition) {
  const tier = AUDIENCE_TIERS.find((entry) => entry.value === campaign.audience);
  if (!tier?.size) return {userErrors: []};

  // A failed rank read finds no customers. Returning no errors would read as a tier
  // with nobody in it.
  const ranked = await customerIds(admin, tierRankQuery(tier));
  if (ranked.userErrors.length) return {userErrors: ranked.userErrors};

  if (ranked.ids.length) {
    const stamped = await (
      await admin.graphql(METAFIELDS_SET, {
        variables: {
          metafields: ranked.ids.map((id) => ({
            ownerId: id,
            namespace: DIMENSION_NAMESPACE,
            key: TIER_METAFIELD.key,
            type: 'single_line_text_field',
            value: campaign.audience,
          })),
        },
      })
    ).json();
    const unstamped = [
      ...transportErrors(stamped),
      ...(stamped.data?.metafieldsSet?.userErrors ?? []),
    ];
    if (unstamped.length) return {userErrors: unstamped};
  }

  // Until the tier is queryable, ShopifyQL can't find its holders. A later activation clears them.
  if (!definition.enabled) return {userErrors: []};
  const holders = await tierHolders(admin, definition.dimension, campaign.audience);
  const dropped = holders.ids.filter((id) => !ranked.ids.includes(id));
  if (!dropped.length) return {userErrors: holders.userErrors};

  // A failed clear leaves the stamps in place. The next activation in this tier retries.
  const cleared = await (
    await admin.graphql(METAFIELDS_DELETE, {
      variables: {
        metafields: dropped.map((id) => ({
          ownerId: id,
          namespace: DIMENSION_NAMESPACE,
          key: TIER_METAFIELD.key,
        })),
      },
    })
  ).json();
  return {
    userErrors: [
      ...transportErrors(cleared),
      ...(cleared.data?.metafieldsDelete?.userErrors ?? []),
    ],
  };
}
// [END campaign-dashboard.stamp-tier]

// [START campaign-dashboard.stamp-orders]
// A store can have thousands of orders in the window, so one bulk operation writes the
// stamps. The close request starts it and returns. The campaign page polls it.
export async function stampOrders(admin, campaign) {
  const touches = touchMarks(campaign);
  // The query skips refund and edit rows. An order placed before the window has no
  // row, and each remaining order's first row is the day it was placed.
  const stamped = new Set();
  const metafields = [];
  for (let offset = 0; ; offset += ORDER_PAGE_SIZE) {
    if (offset >= MAX_PAGES * ORDER_PAGE_SIZE) return {operationId: null, count: 0, userErrors: [tooManyPages]};
    const body = await queryShopifyQL(admin, orderDaysQuery(campaign, offset));
    const unread = shopifyqlErrors(body);
    if (unread.length) return {operationId: null, count: 0, userErrors: unread};

    const rows = body.data?.shopifyqlQuery?.tableData?.rows ?? [];
    metafields.push(
      ...rows
        .map((row) => ({id: row.order_id, touch: lastTouch(touches, row.day)}))
        .filter((order) => order.id && !stamped.has(order.id) && stamped.add(order.id))
        .filter((order) => order.touch)
        .map((order) => ({
          ownerId: `gid://shopify/Order/${order.id}`,
          namespace: DIMENSION_NAMESPACE,
          key: 'campaign_touch',
          type: 'single_line_text_field',
          value: order.touch,
        })),
    );
    // A page shorter than the limit is the last one.
    if (rows.length < ORDER_PAGE_SIZE) break;
  }

  // No orders to stamp starts no operation.
  const started = await startBulkMetafieldsSet(
    admin,
    metafields,
    `campaign-${campaign.id}-order-stamps.jsonl`,
  );
  return {...started, count: metafields.length};
}
// [END campaign-dashboard.stamp-orders]

// Editable until activation. The target filters on these IDs and the annotation uses the
// titles.
export const setProducts = (admin, campaign, products) =>
  updateCampaign(admin, campaign, {products});

// Activation turns an amount into a target. A blank amount is no target.
export const setTargetAmounts = (admin, campaign, amounts) =>
  updateCampaign(admin, campaign, amounts);

// [START campaign-dashboard.audience-edit]
export const setAudience = (admin, campaign, audience) =>
  updateCampaign(admin, campaign, {audience});
// [END campaign-dashboard.audience-edit]

// [START campaign-dashboard.close-with-outcome]
export async function closeCampaign(admin, campaign, text, endedAt) {
  const id = campaign.markers?.campaign;
  // No span means nothing to close. Returning no errors would read as success.
  if (!id) {
    return [{message: 'No campaign annotation to close. Rewrite annotations, then close.'}];
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
// A milestone is one moment. Leave `endedAt` off.
export async function markMilestone(admin, target, markedAt, money) {
  const body = await queryShopifyQL(admin, measureQuery(target.shopifyqlQuery));
  // A parse error has no value to compare. It isn't a target that fell short.
  const failed = shopifyqlErrors(body);
  if (failed.length) return {userErrors: failed};
  const actual = progressValue(body.data?.shopifyqlQuery);
  if (actual === null) return {userErrors: [{message: "Couldn't measure the target."}]};
  if (actual < Number(target.expectedValue)) {
    return {userErrors: [{message: 'Target not reached yet.'}]};
  }

  const created = await (
    await admin.graphql(ANNOTATION_CREATE, {
      variables: {
        input: {
          startedAt: markedAt,
          type: 'revenue_milestone',
          title: clamp(`${target.name} reached`, 75),
          description: `Reached ${money(actual)} against a ${money(
            Number(target.expectedValue),
          )} target.`,
        },
      },
    })
  ).json();

  const result = created.data?.analyticsAnnotationCreate;
  return {
    ...result,
    userErrors: [...transportErrors(created), ...(result?.userErrors ?? [])],
  };
}
// [END campaign-dashboard.milestone]

// [START campaign-dashboard.record-mark]
// Milestones and incidents repeat. Their keys hold what makes them distinct.
// An ID the record doesn't hold is an annotation nothing can find again.
export async function recordMark(admin, campaign, key, id) {
  if (!id) return null;
  const saved = await rememberMarkers(campaign, {[key]: id});
  if (!saved.userErrors.length) return saved;
  const deleted = await (
    await admin.graphql(ANNOTATION_DELETE, {variables: {id}})
  ).json();
  return {
    campaign: null,
    userErrors: [
      ...saved.userErrors,
      ...transportErrors(deleted),
      ...(deleted.data?.analyticsAnnotationDelete?.userErrors ?? []),
    ],
  };
}
// [END campaign-dashboard.record-mark]

// [START campaign-dashboard.flag-incident]
// No bounce type in the vocabulary. The reason goes in the text.
export async function flagIncident(admin, campaign, appName, markedAt) {
  const [funnel, bounces] = await Promise.all([
    runOptional(admin, appEventsQuery(campaign, appName)),
    runOptional(admin, bounceQuery(campaign, appName)),
  ]);

  const incident = detectIncident(campaign, funnel, bounces);
  if (!incident) {
    return {userErrors: [{message: 'No email bounces to flag.'}]};
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

  const result = body.data?.analyticsAnnotationCreate;
  return {
    ...result,
    userErrors: [...transportErrors(body), ...(result?.userErrors ?? [])],
  };
}
// [END campaign-dashboard.flag-incident]

import {
  ANNOTATION_CREATE,
  ANNOTATION_DELETE,
  ANNOTATION_UPDATE,
  BUNDLE_QUERY,
  CUSTOMER_TIERS,
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
  QR_MARK_PREFIX,
  campaignMarks,
  clamp,
  isPositiveAmount,
  lastTouch,
  promotedFilter,
  qrHandles,
  qrLiveOn,
  qrTitle,
  touchMarks,
} from './campaigns';
import {AUDIENCE_TIERS, TIER_METAFIELD, isTargetedTier, tierLabel} from './audiences';

// A skipped target and a rejected one both have no ID. The errors say which.
const NO_TARGET = {id: null, userErrors: []};

// [START campaign-dashboard.store-target]
// Metric, dates, and filters identify a target. Creating this twice is a user error.
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

// A blank amount is no target. Activation skips it.
export const createStoreTarget = (admin, campaign) =>
  isPositiveAmount(campaign.revenueTarget)
    ? createTarget(admin, {
        name: `${campaign.title}: store-wide sales`,
        metric: 'total_sales',
        expectedValue: campaign.revenueTarget,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
      })
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
  });
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
  });
}
// [END campaign-dashboard.audience-target]

// [START campaign-dashboard.qr-target]
// One target per code, from the day it goes live. The attribution metric credits the
// order to the code's utm_campaign, and the filter takes the handle the QR app wrote
// into the scan URL.
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
    });
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

// A campaign that closes early stops counting on the day it closed. Move the end date
// on every target the campaign created, and Shopify rebuilds each measuring query.
// A QR code that wasn't live yet keeps a one-day target, because a target can't end
// before it starts.
export async function endTargetsOn(admin, campaign, day) {
  const read = await readTargets(admin, campaign);
  const problems = [...transportErrors(read)];
  for (const target of problems.length ? [] : targetNodes(read)) {
    const endDate = target.startDate > day ? target.startDate : day;
    const body = await (
      await admin.graphql(TARGET_UPDATE, {
        variables: {id: target.id, input: {endDate}},
      })
    ).json();
    problems.push(
      ...transportErrors(body),
      ...(body.data?.analyticsTargetUpdate?.userErrors ?? []),
    );
  }
  return problems;
}

// Every name above ends in what the target measures. The title in front can change.
const TARGET_ENDINGS = [': store-wide sales', ': promoted products', ' segment', ' QR code'];
export const isOwnTarget = (target) =>
  target.name?.includes(': ') && TARGET_ENDINGS.some((ending) => target.name.endsWith(ending));

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
// By recorded ID. A date-window search misses marks once the merchant edits the
// campaign's dates, and the rewrite doubles them on the timeline. Each problem names
// the annotation it left in place. A failed read names none.
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
      const saved = await rememberMarkers(admin, campaign, {[mark.key]: id});
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
  // The entry's GID. Analytics reads any field on the entry through the reference.
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
// A re-rank moves customers out of the tier. Earlier campaigns in the tier list the
// customers who held it. Their stamps come off, and the tier matches this campaign's members.
export async function stampTier(admin, campaign, campaigns) {
  const tier = AUDIENCE_TIERS.find((entry) => entry.value === campaign.audience);
  if (!tier?.size) return {members: [], userErrors: []};

  const body = await (await admin.graphql(tierRankQuery(tier))).json();
  // A failed rank read finds no customers. Returning no errors would read as a tier
  // with nobody in it.
  const unranked = [
    ...transportErrors(body),
    ...(body.data?.shopifyqlQuery?.parseErrors ?? []).map((message) => ({message})),
  ];
  if (unranked.length) return {members: [], userErrors: unranked};

  // GROUP BY returns a numeric ID. Every mutation below wants a GID.
  const ids = (body.data?.shopifyqlQuery?.tableData?.rows ?? [])
    .map((row) => row.customer_id)
    .filter(Boolean)
    .map((id) => `gid://shopify/Customer/${id}`);

  if (ids.length) {
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
    const unstamped = [
      ...transportErrors(stamped),
      ...(stamped.data?.metafieldsSet?.userErrors ?? []),
    ];
    if (unstamped.length) return {members: [], userErrors: unstamped};
  }

  const earlier = [
    ...new Set(
      campaigns
        .filter((other) => other.gid !== campaign.gid && other.audience === campaign.audience)
        .flatMap((other) => other.members),
    ),
  ].filter((id) => !ids.includes(id));
  if (!earlier.length) return {members: ids, userErrors: []};

  const read = await (
    await admin.graphql(CUSTOMER_TIERS, {variables: {ids: earlier}})
  ).json();
  const unread = transportErrors(read);
  if (unread.length) return {members: ids, userErrors: unread};
  const dropped = (read.data?.nodes ?? [])
    .filter((customer) => customer?.tier?.value === campaign.audience)
    .map((customer) => customer.id);
  if (!dropped.length) return {members: ids, userErrors: []};

  // A failed clear leaves the earlier campaigns listing them. The next stamp retries.
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
    members: ids,
    userErrors: [
      ...transportErrors(cleared),
      ...(cleared.data?.metafieldsDelete?.userErrors ?? []),
    ],
  };
}
// [END campaign-dashboard.stamp-tier]

// [START campaign-dashboard.stamp-orders]
export async function stampOrders(admin, campaign) {
  const touches = touchMarks(campaign);
  const userErrors = [];
  // A refund or edit books a later row for the same order. Rows come oldest first,
  // and the first row is the day the order was placed.
  const stamped = new Set();
  for (let offset = 0; ; offset += ORDER_PAGE_SIZE) {
    const body = await (
      await admin.graphql(orderDaysQuery(campaign, offset))
    ).json();
    const unread = transportErrors(body);
    if (unread.length) return [...userErrors, ...unread];

    const rows = body.data?.shopifyqlQuery?.tableData?.rows ?? [];
    const metafields = rows
      .map((row) => ({id: row.order_id, touch: lastTouch(touches, row.day)}))
      .filter((order) => order.id && !stamped.has(order.id) && stamped.add(order.id))
      .filter((order) => order.touch)
      .map((order) => ({
        ownerId: `gid://shopify/Order/${order.id}`,
        namespace: DIMENSION_NAMESPACE,
        key: 'campaign_touch',
        type: 'single_line_text_field',
        value: order.touch,
      }));

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
    // A page shorter than the limit is the last one.
    if (rows.length < ORDER_PAGE_SIZE) return userErrors;
  }
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
  const body = await (
    await admin.graphql(measureQuery(target.shopifyqlQuery))
  ).json();
  const failed = transportErrors(body);
  if (failed.length) return {userErrors: failed};
  const actual = progressValue(body.data?.shopifyqlQuery);
  if (actual === null || actual < Number(target.expectedValue)) {
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
  const saved = await rememberMarkers(admin, campaign, {[key]: id});
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

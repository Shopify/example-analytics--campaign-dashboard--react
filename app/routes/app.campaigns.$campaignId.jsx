import {Fragment, useEffect, useState} from 'react';
import {redirect, useFetcher, useLoaderData, useRouteError} from 'react-router';
import {
  ComboChart,
  FunnelChartNext,
  LineChart,
  PolarisVizProvider,
  StackedAreaChart,
} from '@shopify/polaris-viz';
import '@shopify/polaris-viz/build/esm/styles.css';
import '../chart-tooltip.css';
import {authenticate} from '../shopify.server';
import {sendCampaignFunnel, shopMorning} from '../app-events.server';
import {
  findCampaign,
  readCampaigns,
  rememberMarkers,
  updateCampaign,
} from '../campaigns.server';
import {
  detectIncident,
  outcomeText,
  readSequence,
} from '../campaign-report.server';
import {
  ANNOTATION_CREATE,
  ANNOTATION_DELETE,
  ANNOTATION_UPDATE,
  BUNDLE_QUERY,
  CUSTOMER_NAMES,
  METAFIELDS_SET,
  SHOP_QUERY,
  TARGETS_DELETE,
  TARGET_CREATE,
  TARGET_UPDATE,
  annotationsQuery,
  appEventsQuery,
  bounceQuery,
  codeSalesQuery,
  emptyTable,
  insightQuery,
  measureQuery,
  orderDaysQuery,
  progressQuery,
  progressValue,
  promotedByQuery,
  runOptional,
  salesQuery,
  sequenceQuery,
  targetsQuery,
  tierRankQuery,
  tierSalesQuery,
  touchSalesQuery,
} from '../campaign-queries.server';
import {
  BOUNCE_ALERT_RATE,
  UNSUB_ALERT_RATE,
  campaignMarks,
  campaignWindow,
  clamp,
  codeFilter,
  creatorCodes,
  creatorTouches,
  lastTouch,
  productId,
  promotedFilter,
  promotedNames,
  touchMarks,
} from '../campaigns';
import {CHANNELS} from '../channels';
import {AUDIENCE_TIERS, TIER_METAFIELD, isTargetedTier, tierLabel} from '../audiences';
import {
  annotationColor,
  categoryLegend,
  exploreLink,
  exploreQuery,
} from '../annotations';
import {findInsight} from '../insight';
import {readDimensions} from '../dimensions.server';

export async function loader({request, params}) {
  // [START campaign-dashboard.campaign-load]
  // Redirect rather than throw. A thrown response renders above this route's layout
  // and takes the app's navigation with it. The search params carry App Bridge's.
  const {admin} = await authenticate.admin(request);
  const {appId, campaigns} = await readCampaigns(admin);
  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) {
    return redirect(`/app/campaigns${new URL(request.url).search}`);
  }
  // [END campaign-dashboard.campaign-load]

  // [START campaign-dashboard.locale]
  // The admin's locale rides in on the request. Formatting here matches the client.
  const locale = new URL(request.url).searchParams.get('locale') ?? 'en';
  // [END campaign-dashboard.locale]

  const dimensions = await readDimensions(admin, appId);
  const queryWindow = campaignWindow(campaign);

  const [
    salesBody,
    targetsBody,
    annotationsBody,
    weekly,
    funnel,
    sequenceTable,
    bounces,
    promoted,
    tierSales,
    touchSales,
    codeSales,
  ] = await Promise.all([
    admin.graphql(salesQuery(campaign)).then((response) => response.json()),
    admin.graphql(targetsQuery(campaign)).then((response) => response.json()),
    admin
      .graphql(annotationsQuery(campaign))
      .then((response) => response.json()),
    runOptional(admin, insightQuery(campaign)),
    runOptional(admin, appEventsQuery(campaign)),
    runOptional(admin, sequenceQuery(campaign)),
    runOptional(admin, bounceQuery(campaign)),
    dimensions.product.enabled
      ? runOptional(admin, promotedByQuery(campaign, dimensions.product.dimension))
      : emptyTable(),
    dimensions.customer.enabled && isTargetedTier(campaign.audience)
      ? runOptional(
          admin,
          tierSalesQuery(campaign, dimensions.customer.dimension, campaign.audience),
        )
      : emptyTable(),
    dimensions.order.enabled
      ? runOptional(admin, touchSalesQuery(campaign, dimensions.order.dimension))
      : emptyTable(),
    // `discount_code` is built in. Only an empty code list skips this.
    codeFilter(campaign)
      ? runOptional(admin, codeSalesQuery(campaign, codeFilter(campaign)))
      : emptyTable(),
  ]);

  // [START campaign-dashboard.parse-errors]
  // Two failure paths. A missing scope nulls the field and lands in `errors`. A string
  // that doesn't parse resolves the field and reports on `parseErrors`.
  const sales = salesBody.data?.shopifyqlQuery;
  const fatal = !sales
    ? (salesBody.errors?.[0]?.message ??
      'shopifyqlQuery returned no data. Check the read_reports scope and Level 2 protected customer data access.')
    : sales.parseErrors?.length
      ? sales.parseErrors.join(' ')
      : null;
  if (fatal) return {campaign, locale, fatal};
  // [END campaign-dashboard.parse-errors]

  // [START campaign-dashboard.measure-targets]
  // Alias each target's generated query into one document and read the results back
  // by position. A null `shopifyqlQuery` is a condition of the request. Skip those.
  const targetNodes = targetsBody.data?.analyticsTargets?.nodes ?? [];
  const measurable = targetNodes.filter((target) => target.shopifyqlQuery);
  const progress = measurable.length
    ? ((await (await admin.graphql(progressQuery(measurable))).json()).data ?? {})
    : {};

  const targets = targetNodes.map((target) => {
    const index = measurable.indexOf(target);
    const actual = index === -1 ? null : progressValue(progress[`t${index}`]);
    const expected = Number(target.expectedValue);
    return {
      ...target,
      actual,
      percent:
        actual === null || expected <= 0
          ? null
          : Math.round((actual / expected) * 100),
      queryError:
        index === -1
          ? `Shopify didn't return a query for ${target.metric} on this read. Its progress can't be measured yet. The target itself is still valid. Reload to try again.`
          : (progress[`t${index}`]?.parseErrors?.[0] ?? null),
    };
  });
  // [END campaign-dashboard.measure-targets]

  const annotations = annotationsBody.data?.shop?.analyticsAnnotations?.nodes ?? [];

  return {
    campaign,
    locale,
    fatal: null,
    appId,
    // The sales dataset has no currency column. Read it off the shop field.
    currencyCode: salesBody.data?.shop?.currencyCode ?? 'USD',
    // TIMESERIES buckets by the store's timezone. The browser's would misdate a marker.
    timeZone: salesBody.data?.shop?.ianaTimezone ?? 'Etc/UTC',
    queryWindow,
    dimensions,
    rows: sales.tableData.rows,
    targets,
    annotations,
    weekly,
    funnel,
    sequence: readSequence(sequenceTable),
    bounces,
    promoted,
    tierSales,
    touchSales,
    codeSales,
    insight: weekly.tableData.rows.length
      ? findInsight(weekly, campaign)
      : null,
  };
}

// A skipped target and a rejected one both have no ID. The errors say which.
const NO_TARGET = {id: null, userErrors: []};

// [START campaign-dashboard.store-target]
// No filter: the whole store over the campaign's window. Metric, dates, and filters
// identify a target, which makes creating this twice a user error.
async function createTarget(admin, input) {
  const body = await (
    await admin.graphql(TARGET_CREATE, {variables: {input}})
  ).json();
  const created = body.data?.analyticsTargetCreate;
  return {
    id: created?.analyticsTarget?.id ?? null,
    userErrors: created?.userErrors ?? [],
  };
}

const createStoreTarget = (admin, campaign) =>
  createTarget(admin, {
    name: `${campaign.title}: store-wide sales`,
    metric: 'total_sales',
    expectedValue: campaign.revenueTarget,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
  });
// [END campaign-dashboard.store-target]

// [START campaign-dashboard.product-target]
// A filter is ShopifyQL, not a label. This one asks what the campaign advertised.
async function createProductTarget(admin, campaign) {
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
async function createAudienceTarget(admin, campaign, definition) {
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
// Round the next target up from what the campaign earned, not to the cent.
async function raiseTarget(admin, target) {
  const actual = Number(target.actual ?? 0);
  const step = Math.max(1000, 10 ** (Math.floor(Math.log10(actual)) - 1));
  const raised = String(Math.ceil(actual / step) * step);

  const body = await (
    await admin.graphql(TARGET_UPDATE, {
      variables: {id: target.id, input: {expectedValue: raised}},
    })
  ).json();
  return body.data?.analyticsTargetUpdate?.userErrors ?? [];
}
// [END campaign-dashboard.raise-target]

// [START campaign-dashboard.bundle-mark]
// A bundle needs `bundle_launch`. Only the store's own data knows which it is.
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
// The store outlives the record's marker IDs. Reconcile against `createdByApp`, the
// one claim of ownership that can't go stale.
async function clearOwnMarks(admin, campaign, appId) {
  const body = await (await admin.graphql(annotationsQuery(campaign))).json();
  const nodes = body.data?.shop?.analyticsAnnotations?.nodes ?? [];
  const problems = [];

  for (const annotation of nodes) {
    if (annotation.createdByApp?.id !== appId) continue;
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
async function writeMarks(admin, campaign, appId, markedAt) {
  const stale = await clearOwnMarks(admin, campaign, appId);
  if (stale.length) {
    return {markers: {}, problems: stale.map((error) => error.message)};
  }

  const launch = await resolveLaunchMark(admin, campaign);
  const markers = {};
  for (const mark of campaignMarks(campaign)) {
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
    if (created?.userErrors?.length) {
      return {markers, problems: created.userErrors.map((error) => error.message)};
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
// Stamp each promoted product with the campaign that pushed it. `$app` resolves to the
// reserved namespace on write, and reads back as `app--<id>.promoted_by`.
async function stampProducts(admin, campaign) {
  if (campaign.products.length === 0) return [];

  const body = await (
    await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: campaign.products.map((product) => ({
          ownerId: product.id,
          namespace: '$app',
          key: 'promoted_by',
          type: 'single_line_text_field',
          value: campaign.title,
        })),
      },
    })
  ).json();
  return body.data?.metafieldsSet?.userErrors ?? [];
}
// [END campaign-dashboard.product-metafield]

// [START campaign-dashboard.stamp-tier]
// The tier written onto the customers themselves. The roster is saved on the record
// too, because the metafield says the tier, not which campaign set it.
async function stampTier(admin, campaign) {
  const tier = AUDIENCE_TIERS.find((entry) => entry.value === campaign.audience);
  if (!tier?.size) return {members: [], userErrors: []};

  const body = await (await admin.graphql(tierRankQuery(tier))).json();
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
          namespace: '$app',
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
    userErrors: stamped.data?.metafieldsSet?.userErrors ?? [],
  };
}
// [END campaign-dashboard.stamp-tier]

// [START campaign-dashboard.stamp-orders]
// Which send an order followed. Only the app knows what it sent.
async function stampOrders(admin, campaign) {
  const body = await (await admin.graphql(orderDaysQuery(campaign))).json();
  const touches = touchMarks(campaign);
  const metafields = (body.data?.shopifyqlQuery?.tableData?.rows ?? [])
    .map((row) => ({id: row.order_id, touch: lastTouch(touches, row.day)}))
    .filter((order) => order.id && order.touch)
    .map((order) => ({
      ownerId: `gid://shopify/Order/${order.id}`,
      namespace: '$app',
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
    userErrors.push(...(batch.data?.metafieldsSet?.userErrors ?? []));
  }
  return userErrors;
}
// [END campaign-dashboard.stamp-orders]

// Editable until launch: the target filters on these IDs, the marker uses the titles.
const setProducts = (admin, campaign, products) =>
  updateCampaign(admin, campaign.id, {products});

// [START campaign-dashboard.audience-edit]
// Moves both the tier on customers and a target's filter. Planned campaigns only.
const setAudience = (admin, campaign, audience) =>
  updateCampaign(admin, campaign.id, {audience});
// [END campaign-dashboard.audience-edit]

// [START campaign-dashboard.close-with-outcome]
// Closing moves `endedAt` from null to the last day and puts the result in the title.
async function closeCampaign(admin, campaign, text, endedAt) {
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
  return body.data?.analyticsAnnotationUpdate?.userErrors ?? [];
}
// [END campaign-dashboard.close-with-outcome]

// [START campaign-dashboard.milestone]
// A moment, not a span, which leaves `endedAt` off. Re-measured on the server.
async function markMilestone(admin, target, markedAt, money) {
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
// Keyed on the record, which is what lets a marker be rewritten and a cancel find it.
// Milestones and incidents repeat. Their keys carry what makes them distinct.
const recordMark = (admin, campaign, key, id) =>
  id ? rememberMarkers(admin, campaign.id, {[key]: id}) : null;
// [END campaign-dashboard.record-mark]

// [START campaign-dashboard.flag-incident]
// No bounce type in the vocabulary. Written as `other` with the reason in the text.
async function flagIncident(admin, campaign, markedAt) {
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

// [START campaign-dashboard.lifecycle]
// One action for every write: read the record, do what the intent names, write it back.
export async function action({request, params}) {
  const {admin} = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get('intent'));

  // Annotation text is written here, and the sales dataset has no currency column.
  const money = (value) =>
    new Intl.NumberFormat('en', {
      style: 'currency',
      currency: String(form.get('currency') || 'USD'),
      maximumFractionDigits: 0,
    }).format(value);

  const [{appId, campaigns}, shopBody] = await Promise.all([
    readCampaigns(admin),
    admin.graphql(SHOP_QUERY).then((response) => response.json()),
  ]);
  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) {
    return redirect(`/app/campaigns${new URL(request.url).search}`);
  }

  const shopId = shopBody.data?.shop?.id ?? null;
  const timeZone = shopBody.data?.shop?.ianaTimezone ?? 'Etc/UTC';

  // Timestamped in the shop's own day, not the browser's.
  const markedAt = (date) =>
    new Date(shopMorning(date, timeZone)).toISOString();

  // `en-CA` formats as YYYY-MM-DD, which every date on a record already is.
  const shopToday = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const dimensions = await readDimensions(admin, appId);

  if (intent === 'set-products') {
    const {userErrors} = await setProducts(
      admin,
      campaign,
      JSON.parse(String(form.get('products'))),
    );
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'set-audience') {
    const {userErrors} = await setAudience(
      admin,
      campaign,
      String(form.get('audience')),
    );
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  // [START campaign-dashboard.send-events-action]
  // Around 680 events, one request each. A real app queues these as its sends happen.
  if (intent === 'send-events') {
    if (!shopId) return {problems: ['Could not read the store ID.']};
    const {accepted, failures} = await sendCampaignFunnel({
      shopId,
      campaignId: campaign.id,
      startDate: campaign.startDate,
      timeZone,
    });
    if (failures.length > 0) return {problems: failures};
    const sent = Object.values(accepted).reduce((total, n) => total + n, 0);
    // Accepted isn't ingested. The funnel stays empty for a few minutes.
    return {ok: true, sentEvents: sent};
  }
  // [END campaign-dashboard.send-events-action]

  if (intent === 'launch') {
    // Gate on the record's status. A target the user set on the same date isn't
    // evidence that this campaign launched.
    if (campaign.status !== 'planned') {
      return {problems: ['This campaign has already been launched.']};
    }

    // Checked against the condition that creates each target. Catching it downstream
    // means nine markers are already up.
    const unset = [];
    if (Number(campaign.revenueTarget) <= 0) unset.push('store-wide revenue');
    if (promotedFilter(campaign) && Number(campaign.productTarget) <= 0) {
      unset.push('promoted product');
    }
    if (
      isTargetedTier(campaign.audience) &&
      dimensions.customer?.enabled &&
      Number(campaign.audienceTarget) <= 0
    ) {
      unset.push(`${tierLabel(campaign.audience)} segment`);
    }
    if (unset.length) {
      return {
        problems: unset.map(
          (goal) => `Set the ${goal} target above zero before launching.`,
        ),
      };
    }

    const {markers, problems: unmarked} = await writeMarks(
      admin,
      campaign,
      appId,
      markedAt,
    );
    if (unmarked.length) return {problems: unmarked};

    // Targets aren't app-scoped. The saved IDs are the only way to cancel safely.
    const [store, product, audience] = await Promise.all([
      createStoreTarget(admin, campaign),
      createProductTarget(admin, campaign),
      createAudienceTarget(admin, campaign, dimensions.customer),
    ]);
    const targets = {};
    const rejected = [];
    for (const [key, result] of [
      ['store', store],
      ['product', product],
      ['audience', audience],
    ]) {
      if (result.id) targets[key] = result.id;
      rejected.push(...result.userErrors);
    }

    const unstamped = await stampProducts(admin, campaign);
    const {members, userErrors: untiered} = await stampTier(admin, campaign);
    const {userErrors} = await updateCampaign(admin, campaign.id, {
      status: 'running',
      markers,
      targets,
      members,
    });
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }

    // A rejected target or stamp is a warning beside a launch, not a failed launch.
    const problems = [...rejected, ...unstamped, ...untiered].map(
      (error) => error.message,
    );
    return problems.length ? {ok: true, problems} : {ok: true};
  }

  // [START campaign-dashboard.rewrite-marks]
  // Replace what's on the store: read this app's own annotations, delete them, and
  // put the current marks up in their place.
  if (intent === 'rewrite-marks') {
    const {markers, problems} = await writeMarks(
      admin,
      campaign,
      appId,
      markedAt,
    );
    if (problems.length) return {problems};

    const {userErrors} = await updateCampaign(admin, campaign.id, {markers});
    return userErrors.length
      ? {problems: userErrors.map((error) => error.message)}
      : {ok: true, rewrote: Object.keys(markers).length};
  }
  // [END campaign-dashboard.rewrite-marks]

  if (intent === 'raise-target') {
    const targetsBody = await (
      await admin.graphql(targetsQuery(campaign))
    ).json();
    const target = (targetsBody.data?.analyticsTargets?.nodes ?? []).find(
      (node) => node.id === String(form.get('targetId')),
    );
    if (!target?.shopifyqlQuery) return {problems: ['That target cannot be measured.']};

    const measured = await (
      await admin.graphql(measureQuery(target.shopifyqlQuery))
    ).json();
    const userErrors = await raiseTarget(admin, {
      ...target,
      actual: progressValue(measured.data?.shopifyqlQuery) ?? 0,
    });
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'milestone') {
    const day = String(form.get('day'));
    const targetsBody = await (
      await admin.graphql(targetsQuery(campaign))
    ).json();
    const target = (targetsBody.data?.analyticsTargets?.nodes ?? []).find(
      (node) => node.id === String(form.get('targetId')),
    );
    if (!target) return {problems: ['That target no longer exists.']};

    const result = await markMilestone(admin, target, markedAt(day), money);
    if (result.userErrors?.length) {
      return {problems: result.userErrors.map((error) => error.message)};
    }
    await recordMark(
      admin,
      campaign,
      `milestone:${productId(target.id)}:${day}`,
      result.analyticsAnnotation?.id,
    );
    return {ok: true};
  }

  if (intent === 'flag-incident') {
    const day = String(form.get('day'));
    const result = await flagIncident(admin, campaign, markedAt(day));
    if (result.userErrors?.length) {
      return {problems: result.userErrors.map((error) => error.message)};
    }
    await recordMark(
      admin,
      campaign,
      `incident:${day}`,
      result.analyticsAnnotation?.id,
    );
    return {ok: true};
  }

  if (intent === 'close') {
    // A campaign can close before its window runs out. Everything below reads the
    // window that actually ran.
    const closedOn =
      shopToday < campaign.endDate ? shopToday : campaign.endDate;
    const closing = {...campaign, endDate: closedOn};

    const [funnel, sequenceTable, targetsBody] = await Promise.all([
      runOptional(admin, appEventsQuery(closing)),
      runOptional(admin, sequenceQuery(closing)),
      admin.graphql(targetsQuery(closing)).then((response) => response.json()),
    ]);

    const store = (targetsBody.data?.analyticsTargets?.nodes ?? []).find(
      (node) => !node.filters,
    );
    const measured = store?.shopifyqlQuery
      ? await (await admin.graphql(measureQuery(store.shopifyqlQuery))).json()
      : null;
    const revenue = progressValue(measured?.data?.shopifyqlQuery) ?? 0;

    const text = outcomeText({
      campaign: closing,
      revenue,
      target: store?.expectedValue,
      sequence: readSequence(sequenceTable),
      money,
    });

    const errors = await closeCampaign(
      admin,
      campaign,
      text,
      markedAt(closedOn),
    );
    if (errors.length) return {problems: errors.map((error) => error.message)};

    // Orders can only be attributed after they exist, which is why this waits for
    // close. Skipped until the definition is a dimension.
    const unattributed = dimensions.order.enabled
      ? await stampOrders(admin, closing)
      : [];
    if (unattributed.length) {
      return {problems: unattributed.map((error) => error.message)};
    }

    await updateCampaign(admin, campaign.id, {
      status: 'closed',
      endDate: closedOn,
    });
    return {ok: true, funnelRows: funnel.tableData.rows.length};
  }

  if (intent === 'cancel') {
    // Exactly the IDs on the record. `analyticsTargetsDelete` will delete any target
    // on the shop, including the user's own.
    for (const id of Object.values(campaign.markers ?? {})) {
      await admin.graphql(ANNOTATION_DELETE, {variables: {id}});
    }

    const ids = Object.values(campaign.targets ?? {});
    if (ids.length > 0) {
      await admin.graphql(TARGETS_DELETE, {variables: {ids}});
    }

    // Canceling undoes the annotations and the targets, and nothing else.
    const {userErrors} = await updateCampaign(admin, campaign.id, {
      status: 'canceled',
      markers: {},
      targets: {},
    });
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'replan') {
    // Canceling already deleted the annotations and the targets. A canceled campaign is
    // a record with nothing on the store, which is what a planned one is.
    const {userErrors} = await updateCampaign(admin, campaign.id, {status: 'planned'});
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  return {problems: [`Unknown intent: ${intent}`]};
}
// [END campaign-dashboard.lifecycle]

// [START campaign-dashboard.unavailable-note]
// A query that never ran looks like a store that sold nothing. Only one is actionable.
function Unavailable({reason, heading}) {
  if (!reason) return null;
  const note = (
    <s-banner tone="info">
      <s-paragraph>This store didn't return it: {reason}</s-paragraph>
    </s-banner>
  );
  return heading ? <s-section heading={heading}>{note}</s-section> : note;
}
// [END campaign-dashboard.unavailable-note]

// What produced the number changes what it means. Every panel names its capabilities.
const CAPABILITIES = {
  shopifyql: {icon: 'database', label: 'ShopifyQL'},
  appEvents: {icon: 'apps', label: 'App Events'},
  metafields: {icon: 'metafields', label: 'Metafields'},
  annotations: {icon: 'note', label: 'Annotations'},
  components: {icon: 'code', label: 'Web components'},
};

// Chips rather than badges, because what a panel is built on doesn't change. Each chip
// names what its capability does in this panel, on hover and on focus. `s-chip` takes no
// `interestFor`, which leaves the clickable variant as the trigger a tooltip can attach
// to. `s-section`'s `heading` takes no elements. Each panel renders its own header.
function PanelHeader({title, uses}) {
  const slug = title.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase();
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-heading>{title}</s-heading>
      {Object.entries(uses).map(([key, note]) => {
        const id = `uses-${slug}-${key}`;
        return (
          <Fragment key={key}>
            <s-tooltip id={id}>{note}</s-tooltip>
            <s-clickable-chip
              color="subdued"
              interestFor={id}
              accessibilityLabel={`Built on ${CAPABILITIES[key].label}`}
            >
              <s-icon slot="graphic" type={CAPABILITIES[key].icon} size="small" />
              {CAPABILITIES[key].label}
            </s-clickable-chip>
          </Fragment>
        );
      })}
    </s-stack>
  );
}

// [START campaign-dashboard.target-bar]
// A share reads as a length before it reads as two amounts. App Home has no progress
// bar. This is two boxes instead: a track, and a fill sized to the percentage. Box
// backgrounds are `subdued`, `base`, or `strong`, which leaves tone to the badge.
function TargetCard({scope, percent, actual, by, expected, format, queryError, children}) {
  const met = percent !== null && percent >= 100;
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{scope}</s-text>
        <s-heading>{format(actual ?? 0)}</s-heading>
        <s-text color="subdued">
          of {format(expected)} by {by}
        </s-text>

        {/* Hidden from assistive tech. The badge below states the same percentage. */}
        <s-box
          background="base"
          borderRadius="large"
          blockSize="8px"
          overflow="hidden"
          accessibilityVisibility="hidden"
        >
          <s-box
            background="strong"
            borderRadius="large"
            blockSize="8px"
            inlineSize={`${Math.min(100, percent ?? 0)}%`}
          />
        </s-box>

        <s-stack direction="inline">
          <s-badge
            progress={met ? 'complete' : 'partiallyComplete'}
            tone={met ? 'success' : 'info'}
          >
            {percent === null ? 'Not measured' : `${percent}% of target`}
          </s-badge>
        </s-stack>

        {queryError && (
          <s-banner tone="warning">
            <s-paragraph>{queryError}</s-paragraph>
          </s-banner>
        )}

        {children}
      </s-stack>
    </s-box>
  );
}
// [END campaign-dashboard.target-bar]

const SINCE_BY_RANGE = {
  today: 'today',
  last7days: 'startOfDay(-7d)',
  last30days: 'startOfDay(-30d)',
  last90days: 'startOfDay(-90d)',
  last365days: 'startOfDay(-365d)',
};

export default function CampaignDashboard() {
  const data = useLoaderData();
  const fetcher = useFetcher();

  // [START campaign-dashboard.client-only]
  // Polaris Viz measures the element it draws into. Gate every chart on mount.
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);
  // [END campaign-dashboard.client-only]

  // [START campaign-dashboard.metric-card-ready]
  // A metric card needs `window.shopify.shopifyQL`, installed after load. Wait for the
  // API rather than for the script tag.
  const [cardReady, setCardReady] = useState(false);
  useEffect(() => {
    let canceled = false;
    const poll = setInterval(() => {
      if (!canceled && window.shopify?.shopifyQL) {
        setCardReady(true);
        clearInterval(poll);
      }
    }, 100);
    return () => {
      canceled = true;
      clearInterval(poll);
    };
  }, []);
  // [END campaign-dashboard.metric-card-ready]

  const [range, setRange] = useState('last30days');
  const [showMarks, setShowMarks] = useState(false);

  useEffect(() => {
    const onScroll = () =>
      document.documentElement.style.setProperty(
        '--chart-scroll-y',
        `${window.scrollY}px`,
      );
    onScroll();
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const {campaign, locale, fatal} = data;

  if (fatal) {
    return (
      <s-page heading={campaign.title}>
        <s-section>
          <s-banner tone="critical" heading="The sales query didn't run">
            <s-paragraph>{fatal}</s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const {
    appId,
    currencyCode,
    timeZone,
    queryWindow,
    dimensions,
    rows,
    targets,
    annotations,
    weekly,
    funnel,
    sequence,
    bounces,
    promoted,
    tierSales,
    touchSales,
    codeSales,
    insight,
  } = data;

  // [START campaign-dashboard.read]
  // Generated column names are the contract. One helper to break in one place.
  const cell = (row, name) => row[name];
  // [END campaign-dashboard.read]

  // [START campaign-dashboard.format]
  // Money comes back as a string, to keep precision. Format at the edge.
  const currency = (value) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(Number(value ?? 0));

  const integer = (value) =>
    new Intl.NumberFormat(locale).format(Number(value ?? 0));

  // A bare YYYY-MM-DD is UTC midnight, a day early west of it. Append a time.
  const asLocalDay = (day) => new Date(`${day}T00:00:00`);

  const shortDate = (day) =>
    new Intl.DateTimeFormat(locale, {month: 'short', day: 'numeric'}).format(
      asLocalDay(day),
    );

  const percent = (value) =>
    value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

  const humanize = (value) => String(value ?? '').replace(/_/g, ' ');

  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

  // Written as 9am in the store's timezone. Slicing the UTC string is a day early.
  const shopDay = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayOf = (instant) => shopDay.format(new Date(instant));
  // [END campaign-dashboard.format]

  // [START campaign-dashboard.totals]
  // WITH TOTALS and COMPARE TO name their columns after the metric.
  const totalSales = rows[0]?.['total_sales__totals'] ?? '0';
  const previousTotal = Number(
    rows[0]?.['comparison_total_sales__previous_period__totals'] ?? 0,
  );
  const percentChange =
    previousTotal === 0
      ? null
      : ((Number(totalSales) - previousTotal) / Math.abs(previousTotal)) * 100;

  // `previous_period` is the same length immediately before. Name the dates it picked.
  const previousWindow = (() => {
    const day = 86400000;
    const start = Date.parse(`${campaign.startDate}T00:00:00Z`);
    const end = Date.parse(`${campaign.endDate}T00:00:00Z`);
    const length = end - start + day;
    return {
      start: new Date(start - length).toISOString().slice(0, 10),
      end: new Date(start - day).toISOString().slice(0, 10),
    };
  })();
  // [END campaign-dashboard.totals]

  // [START campaign-dashboard.target-copy]
  // `filters` is ShopifyQL. Say what it narrows to, and fall back to the expression.
  function targetScope(target) {
    if (!target.filters) return 'Total sales';
    if (target.filters.startsWith('product_id')) {
      const names = promotedNames(campaign);
      return names ? `Sales of ${names}` : 'Sales of the promoted products';
    }
    if (target.filters.includes(dimensions.customer.key)) {
      return `Sales to ${tierLabel(campaign.audience).toLowerCase()}`;
    }
    return `Filtered by ${target.filters}`;
  }
  // [END campaign-dashboard.target-copy]

  // [START campaign-dashboard.target-split]
  // The unfiltered target is the number the campaign gets judged on.
  const storeTarget = targets.find((target) => !target.filters) ?? null;
  const scopedTargets = targets.filter((target) => target.filters);
  // [END campaign-dashboard.target-split]

  // [START campaign-dashboard.annotations-overlay]
  // What the marks are now against what's on the store.
  const marks = campaignMarks(campaign);

  // Split by who wrote them. Grey the rest, which the app can't update or delete.
  const ours = annotations.filter(
    (annotation) => annotation.createdByApp?.id === appId,
  );
  const others = annotations.filter(
    (annotation) => annotation.createdByApp?.id !== appId,
  );

  // Group by day before anything draws them. A launch writes several on one date.
  const byDay = new Map();
  for (const annotation of annotations) {
    const day = dayOf(annotation.startedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(annotation);
  }
  const annotationDays = [...byDay.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  // Keyed on the formatted day, because Polaris Viz matches the axis label it drew and
  // holds one annotation per key. A count costs one row where nine titles cost nine.
  const chartLabel = (title) =>
    clamp(title.replace(` for ${campaign.title}`, '').replace(` on ${campaign.title}`, ''), 24);
  const chartAnnotations = annotationDays.map(([day, list]) => ({
    startKey: shortDate(day),
    label:
      list.length > 1 ? `${list.length} annotations` : chartLabel(list[0].title),
    content: {
      // Portaled into a `foreignObject`. Plain HTML, not elements that upgrade.
      content: (
        <Fragment>
          {list.map((annotation) => (
            <div key={annotation.id}>
              {annotation.description ?? annotation.title}
            </div>
          ))}
        </Fragment>
      ),
      title: list.length > 1 ? shortDate(day) : list[0].title,
    },
    axis: 'x',
    color: annotationColor(list[0], appId),
  }));

  const openCampaign = ours.find((annotation) => !annotation.endedAt) ?? null;
  // Read off the record. The annotations query is windowed and would miss a duplicate.
  const incidentFlagged = Object.keys(campaign.markers ?? {}).some((key) =>
    key.startsWith('incident:'),
  );
  const legend = categoryLegend(annotations, appId);
  // [END campaign-dashboard.annotations-overlay]

  // The same conditions the launch applies.
  const plannedTargetCount =
    1 +
    (campaign.products.length > 0 ? 1 : 0) +
    (isTargetedTier(campaign.audience) && dimensions.customer.enabled ? 1 : 0);

  // [START campaign-dashboard.chart]
  // Money and a count can't share an axis. A ComboChart gives each its own.
  const salesSeries = {
    name: 'Sales',
    data: rows.map((row) => ({
      key: shortDate(cell(row, 'day')),
      value: Number(cell(row, 'total_sales') ?? 0),
    })),
  };

  const ordersSeries = {
    name: 'Orders',
    data: rows.map((row) => ({
      key: shortDate(cell(row, 'day')),
      value: Number(cell(row, 'orders') ?? 0),
    })),
  };
  // [END campaign-dashboard.chart]

  // [START campaign-dashboard.metric-card]
  // The picker reports an alias like `last30days`. The app turns that into a SINCE.
  const since = SINCE_BY_RANGE[range];
  const cardQuery = (metric) =>
    [
      'FROM sales',
      `SHOW ${metric}`,
      'TIMESERIES day WITH TOTALS, PERCENT_CHANGE',
      `SINCE ${since} UNTIL today`,
      'COMPARE TO previous_period',
      `VISUALIZE ${metric} TYPE line`,
    ].join(' ');
  // [END campaign-dashboard.metric-card]

  // [START campaign-dashboard.funnel-totals]
  // One row per day. A campaign total is a column summed rather than a value read.
  const total = (metric) =>
    (funnel.tableData.rows ?? []).reduce(
      (running, row) => running + Number(cell(row, metric) ?? 0),
      0,
    );

  const rate = (value, base) => (base > 0 ? (value / base) * 100 : 0);

  const sent = total('emails_sent') + total('sms_messages_sent') + total('push_notifications_sent');
  const reached = total('emails_delivered') + total('sms_messages_delivered') + total('push_notifications_sent');
  const bounced = total('emails_bounced');
  const unsubscribed = total('email_unsubscribes') + total('sms_unsubscribes');

  const health = {
    bounceRate: rate(bounced, total('emails_sent')),
    unsubRate: rate(unsubscribed, reached),
    reach: rate(reached, sent),
  };
  // [END campaign-dashboard.funnel-totals]

  const listResult =
    unsubscribed === 0
      ? 'Nobody left the list.'
      : `Unsubscribes took ${integer(unsubscribed)} contacts off the list.`;

  // [START campaign-dashboard.reach-stats]
  const channelTotal = (key, slot) => total(CHANNELS[key].metrics[slot]);

  // What the campaign cost the list, per channel. Read off the rows rather than through
  // a metric card, which resolves columns against a catalog of published metrics that
  // App Events columns aren't in.
  const reachRows = campaign.channels
    .map((key) => {
      const metrics = CHANNELS[key].metrics;
      return {
        key,
        label: CHANNELS[key].label,
        sent: channelTotal(key, 'sent'),
        reached: channelTotal(key, 'reached'),
        // A channel with no such metric reports nothing rather than zero.
        bounced: metrics.bounced ? channelTotal(key, 'bounced') : null,
        unsubscribed: metrics.lost ? channelTotal(key, 'lost') : null,
      };
    })
    .filter((row) => row.sent > 0);
  // [END campaign-dashboard.reach-stats]

  // [START campaign-dashboard.channel-funnels]
  // One funnel per channel. Push has no delivery stage, and comparing its middle to
  // email's would compare a send to a delivery.
  const funnels = campaign.channels
    .map((key) => ({
      key,
      label: CHANNELS[key].label,
      stages: CHANNELS[key].stages.map((stage) => [
        stage.label,
        total(stage.metric),
      ]),
    }))
    .filter((entry) => entry.stages[0][1] > 0);
  // [END campaign-dashboard.channel-funnels]

  // [START campaign-dashboard.sends-by-day]
  // The funnel's rows kept as a series. Sends by day beside sales by day.
  const sendsByDay = new Map(
    (funnel.tableData.rows ?? []).map((row) => [cell(row, 'day'), row]),
  );
  const daily = (metric) =>
    rows.map((row) => ({
      key: shortDate(cell(row, 'day')),
      value: Number(cell(sendsByDay.get(cell(row, 'day')) ?? {}, metric) ?? 0),
    }));

  const sends = [
    {name: 'Emails', data: daily('emails_sent')},
    {name: 'Texts', data: daily('sms_messages_sent')},
    {name: 'Pushes', data: daily('push_notifications_sent')},
  ].filter((series) => series.data.some((point) => point.value > 0));
  // [END campaign-dashboard.sends-by-day]

  // [START campaign-dashboard.sequence-charts]
  // Whether the share engaging fell as the campaign kept sending. That's fatigue.
  const sequenceBars = [
    {
      name: 'Reached',
      data: sequence.map((touch) => ({
        key: `${touch.position}. ${touch.name}`,
        value: touch.reached,
      })),
    },
  ];
  const sequenceRate = [
    {
      name: 'Engaged',
      data: sequence.map((touch) => ({
        key: `${touch.position}. ${touch.name}`,
        value: Math.round(touch.rate),
      })),
    },
  ];

  const firstTouch = sequence.at(0);
  const lastTouch = sequence.at(-1);
  const fatigue =
    firstTouch && lastTouch && lastTouch !== firstTouch
      ? {
          from: firstTouch.rate,
          to: lastTouch.rate,
          falling: lastTouch.rate < firstTouch.rate,
          lost: sequence.reduce((running, touch) => running + touch.lost, 0),
          touches: sequence.length,
          worst: sequence.reduce((low, touch) =>
            touch.rate < low.rate ? touch : low,
          ),
        }
      : null;

  const bounceReasons = (bounces.tableData.rows ?? [])
    .filter((row) => Number(cell(row, 'emails_bounced')) > 0)
    .map((row) => ({
      reason: humanize(cell(row, 'recipient_status') ?? 'unrecorded'),
      count: Number(cell(row, 'emails_bounced')),
    }));
  // [END campaign-dashboard.sequence-charts]

  // [START campaign-dashboard.insight-chart]
  // Two markers in one week land on the same point. Merge rather than overlap.
  const insightWeekly = insight
    ? [
        {
          name: insight.title,
          data: insight.weeks.map((week, index) => ({
            key: shortDate(week),
            value: insight.series[index],
          })),
        },
      ]
    : [];

  const insightAnnotations = [];
  if (insight) {
    const weekOf = (day) =>
      insight.weeks.findLast((week) => week <= day) ?? insight.weeks[0];
    const merged = new Map();
    for (const annotation of annotations) {
      const week = weekOf(dayOf(annotation.startedAt));
      if (!merged.has(week)) merged.set(week, []);
      merged.get(week).push(annotation);
    }
    for (const [week, list] of merged) {
      insightAnnotations.push({
        startKey: shortDate(week),
        label: list.length === 1 ? list[0].title : `${list.length} annotations`,
        content: {content: list.map((entry) => entry.title).join('. ')},
        axis: 'x',
        color: annotationColor(list[0], appId),
      });
    }
  }
  // [END campaign-dashboard.insight-chart]

  // [START campaign-dashboard.analytics-link]
  // The store's own explorer, with the query already in it.
  const exploreHref = exploreLink(
    exploreQuery({
      window: queryWindow,
      types: ours.map((annotation) => annotation.type),
    }),
  );
  // [END campaign-dashboard.analytics-link]

  // [START campaign-dashboard.promoted-split]
  // What the campaign promoted against what the store sold anyway, day by day, read
  // back through the store's analytics. Unstamped products come back under an empty
  // value, which is the rest of the store.
  const promotedByDay = new Map();
  const otherByDay = new Map();
  for (const row of promoted.tableData.rows ?? []) {
    const day = String(cell(row, 'day'));
    const bucket =
      String(cell(row, 'promoted_by') ?? '') === campaign.title
        ? promotedByDay
        : otherByDay;
    bucket.set(day, (bucket.get(day) ?? 0) + Number(cell(row, 'total_sales') ?? 0));
  }

  const promotedDays = [
    ...new Set([...otherByDay.keys(), ...promotedByDay.keys()]),
  ].sort();
  const promotedSales = [...promotedByDay.values()].reduce(
    (running, sales) => running + sales,
    0,
  );
  const promotedShare = rate(promotedSales, Number(totalSales));

  const promotedSplit = [
    {
      name: 'Promoted products',
      data: promotedDays.map((day) => ({
        key: shortDate(day),
        value: promotedByDay.get(day) ?? 0,
      })),
    },
    {
      name: 'The rest of the store',
      data: promotedDays.map((day) => ({
        key: shortDate(day),
        value: otherByDay.get(day) ?? 0,
      })),
    },
  ];
  // [END campaign-dashboard.promoted-split]

  // [START campaign-dashboard.tier-shape]
  // A tier the app wrote is a dimension like any other once it's queryable.
  const tierRows = (tierSales.tableData.rows ?? []).map((row) => ({
    day: String(cell(row, 'day')),
    sales: Number(cell(row, 'total_sales') ?? 0),
  }));
  const tierTotal = tierRows.reduce((running, row) => running + row.sales, 0);
  const tierShare = rate(tierTotal, Number(totalSales));
  // [END campaign-dashboard.tier-shape]

  // [START campaign-dashboard.touch-shape]
  // One row per send. Orders the app couldn't attribute come back under an empty value.
  const touchRows = (touchSales.tableData.rows ?? [])
    .map((row) => ({
      touch: String(cell(row, 'touch') ?? ''),
      sales: Number(cell(row, 'total_sales') ?? 0),
      orders: Number(cell(row, 'orders') ?? 0),
    }))
    .filter((row) => row.touch !== '');
  // [END campaign-dashboard.touch-shape]

  // [START campaign-dashboard.code-shape]
  // `discount_code` is built in. The store has no idea two codes are one creator's.
  const byCode = new Map(
    (codeSales.tableData.rows ?? []).map((row) => [
      String(cell(row, 'discount_code') ?? ''),
      {
        sales: Number(cell(row, 'total_sales') ?? 0),
        orders: Number(cell(row, 'orders') ?? 0),
      },
    ]),
  );
  const byCreator = new Map();
  for (const pair of creatorCodes(campaign)) {
    const found = byCode.get(pair.code) ?? {sales: 0, orders: 0};
    const running = byCreator.get(pair.creator) ?? {codes: [], sales: 0, orders: 0};
    byCreator.set(pair.creator, {
      codes: [...running.codes, {code: pair.code, ...found}],
      sales: running.sales + found.sales,
      orders: running.orders + found.orders,
    });
  }
  const creatorRows = [...byCreator.entries()]
    .map(([creator, totals]) => ({creator, ...totals}))
    .sort((first, second) => second.sales - first.sales);

  // What a code proves against what the creator moved. The gap is the halo.
  const codeTotal = creatorRows.reduce((running, row) => running + row.sales, 0);
  const creatorTouchTitles = creatorTouches(campaign);
  const touchedTotal = touchRows
    .filter((row) => creatorTouchTitles.includes(row.touch))
    .reduce((running, row) => running + row.sales, 0);
  // [END campaign-dashboard.code-shape]

  // Two types the app can read and can't write. Either is a competing explanation.
  const supplyTypes = ['supplier_change', 'fulfillment_service_change'];
  const supplyMarks = others.filter((annotation) =>
    supplyTypes.includes(annotation.type),
  );

  // Every line is gated on a threshold. Advice that always appears isn't advice.
  const days = rows.map((row) => String(cell(row, 'day'))).sort();
  const salesByDay = new Map(
    rows.map((row) => [String(cell(row, 'day')), Number(cell(row, 'total_sales') ?? 0)]),
  );
  const averageAround = (day) => {
    const index = days.indexOf(day);
    if (index < 1 || index >= days.length - 1) return null;
    const mean = (list) =>
      list.reduce((running, key) => running + (salesByDay.get(key) ?? 0), 0) /
      list.length;
    return {
      before: mean(days.slice(0, index)),
      after: mean(days.slice(index)),
    };
  };

  // Icon and tone say what kind of finding it is before either line is read.
  const advice = [];

  if (storeTarget?.percent >= 100) {
    advice.push({
      icon: 'check-circle',
      tone: 'success',
      text: `The store-wide target is ${storeTarget.percent}% met with the window still open.`,
    });
  } else if (storeTarget?.percent !== null && storeTarget?.percent < 60) {
    advice.push({
      icon: 'alert-circle',
      tone: 'warning',
      text: `The store-wide target is ${storeTarget.percent}% met, ${currency(
        Number(storeTarget.expectedValue) - Number(storeTarget.actual ?? 0),
      )} short of ${currency(storeTarget.expectedValue)}.`,
    });
  }

  // Bounces are the banner's subject, on the same threshold. Not repeated here.

  if (fatigue?.falling && fatigue.from - fatigue.to >= 10) {
    advice.push({
      icon: 'alert-triangle',
      tone: 'caution',
      text: `Engagement fell from ${Math.round(
        fatigue.from,
      )}% on the first send to ${Math.round(fatigue.to)}% on send ${
        fatigue.touches
      }.`,
    });
  }

  if (health.unsubRate >= UNSUB_ALERT_RATE * 100) {
    advice.push({
      icon: 'alert-triangle',
      tone: 'caution',
      text: `Unsubscribes were ${health.unsubRate.toFixed(
        1,
      )}% of the contacts this campaign reached.`,
    });
  }

  if (promotedByDay.size > 0 && promotedShare < 25) {
    advice.push({
      icon: 'product',
      tone: 'info',
      text: `The promoted products are ${promotedShare.toFixed(
        0,
      )}% of what sold.`,
    });
  }

  const launchMarker = campaign.markers?.launch
    ? ours.find((annotation) => annotation.id === campaign.markers.launch)
    : null;
  const launchDay = launchMarker?.startedAt
    ? dayOf(launchMarker.startedAt)
    : null;
  const launchEffect = launchDay ? averageAround(launchDay) : null;
  if (launchEffect && launchEffect.before > 0) {
    const lift = rate(launchEffect.after - launchEffect.before, launchEffect.before);
    if (Math.abs(lift) >= 10) {
      advice.push({
        icon: lift > 0 ? 'check-circle' : 'alert-triangle',
        tone: lift > 0 ? 'success' : 'caution',
        text: `Daily sales ${lift > 0 ? 'averaged' : 'fell to'} ${currency(
          launchEffect.after,
        )} after the launch against ${currency(
          launchEffect.before,
        )} before it, a ${Math.abs(lift).toFixed(0)}% ${
          lift > 0 ? 'lift' : 'drop'
        }.`,
      });
    }
  }

  // A mark's own day and the one after it, against the two days before. A wider window
  // picks up the next mark's effect and credits it to this one.
  const localLift = (day) => {
    const index = days.indexOf(day);
    if (index < 2 || index > days.length - 2) return null;
    const mean = (slice) =>
      slice.reduce((running, key) => running + (salesByDay.get(key) ?? 0), 0) /
      slice.length;
    const before = mean(days.slice(index - 2, index));
    if (before <= 0) return null;
    return {before, after: mean(days.slice(index, index + 2))};
  };

  // Only the marks this app actually wrote. A planned mark isn't on the chart to explain.
  const lifted = touchMarks(campaign)
    .map((mark) => ({
      title: mark.label ?? mark.title,
      written: ours.find((item) => item.id === campaign.markers?.[mark.key]),
    }))
    .filter((entry) => entry.written)
    .map((entry) => ({
      title: entry.title,
      effect: localLift(dayOf(entry.written.startedAt)),
    }))
    .filter((entry) => entry.effect)
    .map((entry) => ({
      ...entry,
      lift: rate(entry.effect.after - entry.effect.before, entry.effect.before),
    }))
    .sort((first, second) => second.lift - first.lift);

  if (lifted[0]?.lift >= 25) {
    const best = lifted[0];
    advice.push({
      icon: 'check-circle',
      tone: 'success',
      text: `${best.title} moved sales most. Daily sales averaged ${currency(
        best.effect.after,
      )} over its first two days against ${currency(
        best.effect.before,
      )} in the two before it, a ${best.lift.toFixed(0)}% lift.`,
    });
  } else if (lifted.length >= 2) {
    advice.push({
      icon: 'alert-triangle',
      tone: 'caution',
      text: `None of the ${lifted.length} campaign touches lifted daily sales by 25% or more over the two days that followed it.`,
    });
  }

  if (supplyMarks.length > 0) {
    advice.push({
      icon: 'info',
      tone: 'info',
      text: `${supplyMarks.length} supply-side change${
        supplyMarks.length === 1 ? '' : 's'
      } landed inside this window. Read the result against that before crediting the campaign.`,
    });
  }

  const problems = fetcher.data?.problems ?? [];
  // Problems alongside `ok` mean the action landed with something rejected inside it.
  const partial = Boolean(fetcher.data?.ok);
  const busy = fetcher.state !== 'idle';
  const today = dayOf(Date.now());
  // Closing early ends it today, not on the planned date. The action clamps the same.
  const closesOn = today < campaign.endDate ? today : campaign.endDate;

  const submit = (intent, fields = {}) =>
    fetcher.submit(
      {
        intent,
        currency: currencyCode,
        ...fields,
      },
      {method: 'post'},
    );

  async function changeProducts() {
    const selection = await shopify.resourcePicker({
      type: 'product',
      selectionIds: campaign.products.map((product) => ({id: product.id})),
      multiple: 5,
    });
    if (!selection) return;
    submit('set-products', {
      products: JSON.stringify(
        selection.map((product) => ({id: product.id, title: product.title})),
      ),
    });
  }

  const planned = campaign.status === 'planned';
  const running = campaign.status === 'running';

  // A percentage says nothing about whether the rest can be earned. This divides the
  // same two numbers by the days on either side of today.
  const dayGap = (from, to) =>
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000,
    );
  const pace =
    storeTarget && storeTarget.percent !== null
      ? (() => {
          const span = dayGap(campaign.startDate, campaign.endDate) + 1;
          const elapsed = Math.min(
            Math.max(1, dayGap(campaign.startDate, today) + 1),
            span,
          );
          const left =
            today <= campaign.endDate ? dayGap(today, campaign.endDate) + 1 : 0;
          const earned = Number(storeTarget.actual ?? 0);
          const short = Math.max(0, Number(storeTarget.expectedValue) - earned);
          return {perDay: earned / elapsed, needed: left > 0 ? short / left : short, left};
        })()
      : null;

  const markNote =
    !planned && ours.length === 0
      ? 'This campaign has no annotations on the chart.'
      : ours.length > marks.length
        ? `${ours.length - marks.length} annotations on this chart are left over from ` +
          `earlier marks on this campaign. Rewriting replaces them with the current ${marks.length}.`
        : null;

  return (
    <s-page heading={campaign.title}>
      {problems.length > 0 && (
        <s-section>
          <s-banner
            tone={partial ? 'warning' : 'critical'}
            heading={
              partial
                ? "Some of that didn't go through"
                : "That didn't go through"
            }
          >
            <s-unordered-list>
              {problems.map((problem) => (
                <s-list-item key={problem}>{problem}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        </s-section>
      )}

      {/* [START campaign-dashboard.status-render] */}
      {/* Which writes are offered follows the campaign's state. */}
      <s-section>
        <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge
            tone={running ? 'success' : campaign.status === 'closed' ? 'info' : undefined}
          >
            {campaign.status}
          </s-badge>
          <s-text color="subdued">
            {shortDate(campaign.startDate)} to {shortDate(campaign.endDate)}
          </s-text>
          <s-text color="subdued">
            {campaign.channels.map((key) => CHANNELS[key].label).join(', ')}
          </s-text>
        </s-stack>

        <s-stack direction="inline" gap="base">
          {planned && (
            <s-button variant="primary" loading={busy} onClick={() => submit('launch')}>
              Launch the campaign
            </s-button>
          )}
          {running && (
            <s-button loading={busy} onClick={() => submit('close')}>
              Close the campaign with its result
            </s-button>
          )}
          {campaign.status === 'canceled' ? (
            <s-button variant="primary" loading={busy} onClick={() => submit('replan')}>
              Plan the campaign again
            </s-button>
          ) : (
            <s-button tone="critical" loading={busy} onClick={() => submit('cancel')}>
              Cancel the campaign
            </s-button>
          )}
        </s-stack>
        </s-stack>
      </s-section>
      {/* [END campaign-dashboard.status-render] */}

      {planned && (
        <Fragment>
          {/* Everything the launch will write, listed before it writes it. */}
          <s-section heading="Campaign setup">
            <s-unordered-list>
              <s-list-item>
                Write {marks.length} annotations to the store's analytics, one of them
                an open span for the campaign itself.
              </s-list-item>
              <s-list-item>
                Create {plannedTargetCount} analytics{' '}
                {plannedTargetCount === 1 ? 'target' : 'targets'} over{' '}
                {shortDate(campaign.startDate)} to {shortDate(campaign.endDate)}.
              </s-list-item>
              <s-list-item>
                Stamp {campaign.products.length} products with{' '}
                <s-text>promoted_by</s-text>
                {isTargetedTier(campaign.audience)
                  ? ` and tag the ${tierLabel(campaign.audience).toLowerCase()} segment.`
                  : '. No customer is tagged. This segment is the whole store.'}
              </s-list-item>
            </s-unordered-list>

            <s-stack direction="block" gap="small-200">
              <s-text>
                Promoted products:{' '}
                {promotedNames(campaign) || 'none selected yet'}
              </s-text>
              <s-stack direction="inline" gap="base">
                <s-button loading={busy} onClick={changeProducts}>
                  {campaign.products.length > 0
                    ? 'Change products'
                    : 'Select products'}
                </s-button>
                <s-select
                  label="Customer segment"
                  value={campaign.audience}
                  onChange={(event) =>
                    submit('set-audience', {audience: event.currentTarget.value})
                  }
                >
                  {AUDIENCE_TIERS.map((tier) => (
                    <s-option key={tier.value} value={tier.value}>
                      {tier.label}
                    </s-option>
                  ))}
                </s-select>
              </s-stack>
            </s-stack>
          </s-section>

          {/* The three amounts as typed, before any is a target. */}
          <s-section heading="Targets">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Target</s-table-header>
                <s-table-header listSlot="labeled">Measures</s-table-header>
                <s-table-header listSlot="labeled">Amount</s-table-header>
              </s-table-header-row>
              <s-table-body>
                <s-table-row>
                  <s-table-cell>Store-wide</s-table-cell>
                  <s-table-cell>Total sales</s-table-cell>
                  <s-table-cell>{currency(campaign.revenueTarget)}</s-table-cell>
                </s-table-row>
                <s-table-row>
                  <s-table-cell>Promoted products</s-table-cell>
                  <s-table-cell>
                    {promotedNames(campaign) || 'No products selected'}
                  </s-table-cell>
                  <s-table-cell>{currency(campaign.productTarget)}</s-table-cell>
                </s-table-row>
                {isTargetedTier(campaign.audience) && (
                  <s-table-row>
                    <s-table-cell>Customer segment</s-table-cell>
                    <s-table-cell>
                      Sales to {tierLabel(campaign.audience).toLowerCase()}
                    </s-table-cell>
                    <s-table-cell>
                      {currency(campaign.audienceTarget)}
                    </s-table-cell>
                  </s-table-row>
                )}
              </s-table-body>
            </s-table>
          </s-section>
        </Fragment>
      )}

      {/* A campaign that hasn't launched has nothing attributed to it. Reporting the
          store's sales for those dates would read as the campaign's own result. */}
      {!planned && (
        <Fragment>
        {/* [START campaign-dashboard.target-render] */}
        {/* The store-wide target first, then the slices of it. */}
        {targets.length > 0 && (
          <s-section>
            <PanelHeader
              title="Targets"
              uses={{
                shopifyql:
                  "Reads the store's actual sales for the window each target is measured against.",
              }}
            />
            <s-paragraph>
              Shopify measures each target against the store's own sales.
            </s-paragraph>

            {/* Drawn the same way as the whole, to be compared by looking. */}
            <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
              {storeTarget && (
                <TargetCard
                  scope={targetScope(storeTarget)}
                  percent={storeTarget.percent}
                  actual={storeTarget.actual}
                  by={shortDate(campaign.endDate)}
                  expected={storeTarget.expectedValue}
                  format={currency}
                  queryError={storeTarget.queryError}
                >
                  {running &&
                    storeTarget.percent !== null &&
                    storeTarget.percent >= 100 && (
                      <s-stack direction="inline" gap="base">
                        <s-button
                          loading={busy}
                          onClick={() =>
                            submit('milestone', {
                              targetId: storeTarget.id,
                              day: today,
                            })
                          }
                        >
                          Mark the day it was hit
                        </s-button>
                        <s-button
                          loading={busy}
                          onClick={() =>
                            submit('raise-target', {targetId: storeTarget.id})
                          }
                        >
                          Raise the target
                        </s-button>
                      </s-stack>
                    )}
                </TargetCard>
              )}

              {scopedTargets.map((target) => (
                <TargetCard
                  key={target.id}
                  scope={targetScope(target)}
                  percent={target.percent}
                  actual={target.actual}
                  by={shortDate(campaign.endDate)}
                  expected={target.expectedValue}
                  format={currency}
                  queryError={target.queryError}
                />
              ))}

              {/* What the target needs per day against what it's averaged. The percentage
                  alone can't say whether it's behind. */}
              {pace && (
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-stack direction="block" gap="small-300">
                    <s-text color="subdued">Store-wide daily pace</s-text>
                    <s-heading>{currency(pace.perDay)} a day</s-heading>
                    <s-text color="subdued">
                      {pace.left === 0
                        ? 'The window has closed.'
                        : `${currency(pace.needed)} a day over the ${
                            pace.left
                          } ${pace.left === 1 ? 'day' : 'days'} left hits the target.`}
                    </s-text>
                    <s-stack direction="inline">
                      <s-badge
                        icon={pace.perDay >= pace.needed ? 'check-circle' : 'clock'}
                        tone={pace.perDay >= pace.needed ? 'success' : 'info'}
                      >
                        {pace.left === 0
                          ? 'Window closed'
                          : pace.perDay >= pace.needed
                            ? 'On pace'
                            : 'Behind pace'}
                      </s-badge>
                    </s-stack>
                  </s-stack>
                </s-box>
              )}
            </s-grid>
          </s-section>
        )}
        {/* [END campaign-dashboard.target-render] */}

        {/* Nothing appears unless its threshold was crossed. */}
        {advice.length > 0 && (
          <s-section heading="Campaign performance">
            <s-stack direction="block" gap="small-100">
              {advice.map((line) => (
                <s-box
                  key={line.text}
                  padding="base"
                  background="subdued"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="small-100" alignItems="start">
                    <s-icon type={line.icon} tone={line.tone} />
                    <s-text>{line.text}</s-text>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          </s-section>
        )}

        {/* [START campaign-dashboard.card-render] */}
        {/* Three numbers the app doesn't calculate. Wait for the ShopifyQL API, or the
            cards mount into an error state they never leave. */}
        <s-section>
          <PanelHeader
            title="Store totals"
            uses={{
              components:
                "Each card is Shopify's own metric card, which renders the query itself.",
              shopifyql:
                'The query behind every card, down to the VISUALIZE clause that draws it.',
            }}
          />
          {cardReady ? (
            <s-metrics-bar accessibilityLabel="Store totals over the selected range">
              <s-metrics-bar-date-picker
                value={range}
                onChange={(event) => setRange(event.currentTarget.value)}
              />
              <s-shopifyql-metric-card
                heading="Total sales"
                query={cardQuery('total_sales')}
              />
              <s-shopifyql-metric-card heading="Orders" query={cardQuery('orders')} />
              <s-shopifyql-metric-card
                heading="Average order value"
                query={cardQuery('average_order_value')}
              />
            </s-metrics-bar>
          ) : (
            <s-metrics-bar loading accessibilityLabel="Loading store totals" />
          )}
        </s-section>
        {/* [END campaign-dashboard.card-render] */}

        <s-section>
          <PanelHeader
            title={`Sales and orders — ${campaign.title}`}
            uses={{
              shopifyql:
                'One row per day for sales and orders, with the previous period beside it.',
              annotations:
                "The marks on the chart, read back from the store's own annotations.",
            }}
          />
          {/* The percentage is Shopify's, from COMPARE TO previous_period. */}
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">Total sales</s-text>
            <s-heading>{currency(totalSales)}</s-heading>
            {percentChange !== null && (
              <s-stack direction="inline">
                <s-badge
                  tone={percentChange >= 0 ? 'success' : 'critical'}
                  icon={percentChange >= 0 ? 'arrow-up' : 'arrow-down'}
                >
                  {percent(percentChange)}
                </s-badge>
              </s-stack>
            )}
            <s-text color="subdued">
              {percentChange === null
                ? `Nothing sold ${shortDate(previousWindow.start)} to ${shortDate(previousWindow.end)}.`
                : `Against ${currency(previousTotal)} over ${shortDate(previousWindow.start)} to ${shortDate(previousWindow.end)}.`}
            </s-text>
          </s-stack>

          {/* [START campaign-dashboard.chart-render] */}
          {/* Each group gets an axis. `series` is the data, `data` the groups. */}
          {isClient && (
            <div className="chart-tooltip-fix" style={{height: '320px'}}>
              <PolarisVizProvider>
                <ComboChart
                  data={[
                    {
                      shape: 'Bar',
                      name: sends.length > 0 ? 'Messages sent' : 'Orders',
                      yAxisOptions: {integersOnly: true},
                      series: sends.length > 0 ? sends : [ordersSeries],
                    },
                    {
                      shape: 'Line',
                      name: 'Sales',
                      yAxisOptions: {labelFormatter: currency},
                      series: [salesSeries],
                    },
                  ]}
                  annotations={chartAnnotations}
                  theme="Light"
                />
              </PolarisVizProvider>
            </div>
          )}
          {/* [END campaign-dashboard.chart-render] */}

          <s-stack direction="inline" gap="base">
            {legend.map((entry) => (
              <s-stack key={entry.label} direction="inline" gap="small-500" alignItems="center">
                <div
                  style={{
                    width: '12px',
                    height: '12px',
                    borderRadius: '2px',
                    backgroundColor: entry.color,
                  }}
                />
                <s-text color="subdued">
                  {entry.label} ({entry.count})
                </s-text>
              </s-stack>
            ))}
          </s-stack>

          {/* [START campaign-dashboard.rewrite-render] */}
          {/* Replacing what the app already wrote, or the chart accumulates every version
              of the story. */}
          <s-stack direction="block" gap="base">
            <s-link href={exploreHref} target="_blank">
              Open this report in the store&rsquo;s analytics dashboard
            </s-link>
            {!planned && (
              <Fragment>
                {markNote && <s-text color="subdued">{markNote}</s-text>}
                <s-stack direction="inline">
                  <s-button loading={busy} onClick={() => submit('rewrite-marks')}>
                    {ours.length > 0 ? 'Rewrite' : 'Write'} the {marks.length}{' '}
                    annotations on this chart
                  </s-button>
                </s-stack>
              </Fragment>
            )}
          </s-stack>
          {/* [END campaign-dashboard.rewrite-render] */}
        </s-section>


        <Unavailable heading="Insight" reason={weekly.unavailable} />

        {/* Say what the comparison needs rather than dropping the section silently. */}
        {!insight && !weekly.unavailable && (
          <s-section heading="Store-wide weekly movement">
            <s-paragraph>
              This panel reads the store's best-selling product before and
              during {campaign.title}. It needs a week of the campaign that has
              finished and a product that was already selling in the weeks
              before launch. This store doesn't have both.
            </s-paragraph>
          </s-section>
        )}

        {/* [START campaign-dashboard.insight-render] */}
        {/* The store's best seller going in, measured before and during. */}
        {insight && isClient && (
          <s-section>
            <s-stack direction="block" gap="small-200">
              {/* Shopify's admin ships its own insights and exposes no API for them. */}
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text color="subdued">Store-wide weekly movement</s-text>
                <s-tooltip id="uses-insight-shopifyql">
                  Weekly sales for the top products, from before launch through today.
                </s-tooltip>
                <s-clickable-chip
                  color="subdued"
                  interestFor="uses-insight-shopifyql"
                  accessibilityLabel={`Built on ${CAPABILITIES.shopifyql.label}`}
                >
                  <s-icon
                    slot="graphic"
                    type={CAPABILITIES.shopifyql.icon}
                    size="small"
                  />
                  {CAPABILITIES.shopifyql.label}
                </s-clickable-chip>
              </s-stack>
              <s-heading>
                {insight.title} during {campaign.title}
              </s-heading>
              <s-paragraph>
                {currency(insight.during)} a week across the{' '}
                {plural(insight.campaignWeeks, 'week')} the campaign has run,{' '}
                {insight.growth === 0
                  ? 'level with'
                  : `${Math.abs(insight.growth)}% ${
                      insight.rising ? 'above' : 'below'
                    }`}{' '}
                the {currency(insight.leadIn)} a week it sold in the{' '}
                {plural(insight.leadInWeeks, 'week')} before launch.
              </s-paragraph>
              <s-text color="subdued">
                The store's best selling product leading up to the start of the
                campaign. The chart below shows how well this product performed
                during the {campaign.title} campaign.
              </s-text>
            </s-stack>

            <div className="chart-tooltip-fix" style={{height: '220px'}}>
              <PolarisVizProvider>
                <LineChart
                  data={insightWeekly}
                  annotations={showMarks ? insightAnnotations : []}
                  theme="Light"
                />
              </PolarisVizProvider>
            </div>

            <s-button
              variant="tertiary"
              onClick={() => setShowMarks((shown) => !shown)}
            >
              {showMarks ? 'Hide the annotations' : 'List the annotations'}
            </s-button>
          </s-section>
        )}
        {/* [END campaign-dashboard.insight-render] */}

        {/* [START campaign-dashboard.send-events-render] */}
        {/* The only panel that writes to App Events. Ingestion isn't immediate. */}
        {(funnel.tableData.rows ?? []).length === 0 && (
          <s-section>
            <PanelHeader
              title="Campaign events"
              uses={{
                appEvents:
                  'The events this app published as the campaign ran, queried like any dataset.',
              }}
            />
            {funnel.unavailable ? (
              <s-banner tone="info">
                <s-paragraph>
                  This store can't query App Events yet: {funnel.unavailable}
                </s-paragraph>
              </s-banner>
            ) : (
              <Fragment>
                <s-paragraph>
                  Replay this campaign's sends as App Events: nine sends across
                  email, SMS, and push, plus the forms that grew the list. That's
                  around 680 events at one request each. Expect a minute or two.
                </s-paragraph>
                <s-paragraph>
                  Shopify accepts an event before it ingests it. The funnels stay
                  empty for a few minutes after this finishes. Reload the page then.
                </s-paragraph>
                {typeof fetcher.data?.sentEvents === 'number' && (
                  <s-banner tone="success">
                    <s-paragraph>
                      {integer(fetcher.data.sentEvents)} events accepted. Reload in a
                      few minutes to see the funnels.
                    </s-paragraph>
                  </s-banner>
                )}
                <s-button loading={busy} onClick={() => submit('send-events')}>
                  Send the campaign's events
                </s-button>
              </Fragment>
            )}
          </s-section>
        )}
        {/* [END campaign-dashboard.send-events-render] */}

        {/* [START campaign-dashboard.funnel-render] */}
        {/* One funnel per channel. One chart would compare a send to a delivery. */}
        {isClient && funnels.length > 0 && (
          <s-section>
            <PanelHeader
              title="Channel metrics"
              uses={{
                appEvents:
                  'Sends, deliveries, and engagement, from the events this app published.',
                shopifyql:
                  "Buckets those events by day across the campaign's own window.",
              }}
            />
            <s-query-container>
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
                {funnels.map((entry) => (
                  <s-grid-item key={entry.key}>
                    <s-heading>{entry.label}</s-heading>
                    <div style={{height: '220px'}}>
                      <PolarisVizProvider>
                        <FunnelChartNext
                          data={[
                            {
                              name: entry.label,
                              data: entry.stages.map(([key, value]) => ({
                                key,
                                value,
                              })),
                            },
                          ]}
                          labelFormatter={integer}
                          percentageFormatter={(value) => `${Math.round(value)}%`}
                          theme="Light"
                        />
                      </PolarisVizProvider>
                    </div>
                  </s-grid-item>
                ))}
              </s-grid>
            </s-query-container>
          </s-section>
        )}
        {/* [END campaign-dashboard.funnel-render] */}

        {/* [START campaign-dashboard.incident-banner] */}
        {/* A problem on the store's charts reaches someone who never opens this app. */}
        {health.bounceRate >= BOUNCE_ALERT_RATE * 100 && (
          <s-section>
            <s-banner
              tone="warning"
              heading={`${health.bounceRate.toFixed(1)}% of this campaign's emails bounced`}
            >
              <s-paragraph>
                {integer(bounced)} of {integer(total('emails_sent'))} emails didn't
                arrive
                {bounceReasons.length > 0
                  ? `, mostly ${bounceReasons[0].reason}`
                  : ''}
                . Clean the list before the next send, because deliverability
                carries between campaigns.
              </s-paragraph>
              <s-paragraph>
                Marking it writes a dated note onto the store's sales charts.
                Whoever reviews this week's numbers then sees the failed send
                beside them, without opening this app.
              </s-paragraph>
              <s-box paddingBlockStart="base">
                {incidentFlagged ? (
                  <s-text color="subdued">Already marked on the store's charts.</s-text>
                ) : (
                  <s-button
                    loading={busy}
                    onClick={() => submit('flag-incident', {day: today})}
                  >
                    Mark the bounce on the store's charts
                  </s-button>
                )}
              </s-box>
            </s-banner>
          </s-section>
        )}
        {/* [END campaign-dashboard.incident-banner] */}

        {/* [START campaign-dashboard.app-events-render] */}
        {/* Reach falls because lists shrink. Engagement falling is fatigue. */}
        {sequence.length > 0 && (
          <s-section>
            <PanelHeader
              title="Send performance"
              uses={{
                appEvents: 'One event stream per send, published by this app at send time.',
                shopifyql:
                  "Groups those events by send so each one's reach stands on its own.",
              }}
            />
            {isClient && (
              <div className="chart-tooltip-fix" style={{height: '280px'}}>
                <PolarisVizProvider>
                  <ComboChart
                    data={[
                      {
                        shape: 'Bar',
                        name: 'Reached',
                        yAxisOptions: {integersOnly: true},
                        series: sequenceBars,
                      },
                      {
                        shape: 'Line',
                        name: 'Engaged',
                        yAxisOptions: {
                          labelFormatter: (value) => `${Math.round(value)}%`,
                        },
                        series: sequenceRate,
                      },
                    ]}
                    theme="Light"
                  />
                </PolarisVizProvider>
              </div>
            )}

            {fatigue && (
              <s-paragraph>
                Engagement {fatigue.falling ? 'fell' : 'rose'} from{' '}
                {Math.round(fatigue.from)}% on the first send to{' '}
                {Math.round(fatigue.to)}% on the last, across {fatigue.touches}{' '}
                sends. The weakest was {fatigue.worst.name} at{' '}
                {Math.round(fatigue.worst.rate)}%. {integer(fatigue.lost)} people
                unsubscribed.
              </s-paragraph>
            )}

            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Send</s-table-header>
                <s-table-header listSlot="labeled">Sent</s-table-header>
                <s-table-header listSlot="labeled">Reached</s-table-header>
                <s-table-header listSlot="labeled">Engaged</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {sequence.map((touch) => (
                  <s-table-row key={touch.template}>
                    <s-table-cell>
                      {touch.position}. {touch.name}
                    </s-table-cell>
                    <s-table-cell>{integer(touch.sent)}</s-table-cell>
                    <s-table-cell>{integer(touch.reached)}</s-table-cell>
                    <s-table-cell>
                      {integer(touch.engaged)} {touch.action} ·{' '}
                      {Math.round(touch.rate)}%
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        )}
        {/* [END campaign-dashboard.app-events-render] */}

        {/* [START campaign-dashboard.reach-render] */}
        {/* A campaign can earn money and still cost the store contacts. */}
        {sent > 0 && (
          <s-section>
            <PanelHeader
              title="Deliverability"
              uses={{
                appEvents:
                  'Bounces and unsubscribes, from the events this app published per send.',
                shopifyql: 'Filters those events to this campaign and totals them by send.',
              }}
            />
            <s-paragraph>
              {health.reach.toFixed(1)}% of {integer(sent)} sends arrived.{' '}
              {listResult}
            </s-paragraph>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Channel</s-table-header>
                <s-table-header listSlot="labeled">Sent</s-table-header>
                <s-table-header listSlot="labeled">Bounced</s-table-header>
                <s-table-header listSlot="labeled">Unsubscribed</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {reachRows.map((row) => (
                  <s-table-row key={row.key}>
                    <s-table-cell>{row.label}</s-table-cell>
                    <s-table-cell>{integer(row.sent)}</s-table-cell>
                    <s-table-cell>
                      {row.bounced === null
                        ? 'Not reported'
                        : `${integer(row.bounced)} · ${rate(row.bounced, row.sent).toFixed(1)}% of sent`}
                    </s-table-cell>
                    <s-table-cell>
                      {row.unsubscribed === null
                        ? 'Not reported'
                        : `${integer(row.unsubscribed)} · ${rate(row.unsubscribed, row.reached).toFixed(1)}% of reached`}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        )}
        {/* [END campaign-dashboard.reach-render] */}

        <Unavailable
          heading="Promoted product sales"
          reason={promoted.unavailable}
        />

        {/* [START campaign-dashboard.promoted-render] */}
        {/* The split the app's own dimension makes possible. */}
        {promotedByDay.size > 0 && (
          <s-section id="promoted">
            <Fragment>
              <PanelHeader
                title="Promoted product sales"
                uses={{
                  shopifyql:
                    "Groups the store's daily sales by the campaign that promoted each product.",
                  metafields:
                    'Stamps every promoted product with the campaign name at launch.',
                }}
              />
              <s-paragraph>
                {currency(promotedSales)} of {currency(totalSales)} came from
                products this campaign promoted, which is{' '}
                {promotedShare.toFixed(0)}% of what the store sold.
              </s-paragraph>
              <s-paragraph>
                The store grouped that split by{' '}
                <s-text type="strong">{dimensions.product.dimension}</s-text>, the
                dimension this app created.
              </s-paragraph>
              {isClient && (
                <div className="chart-tooltip-fix" style={{height: '260px'}}>
                  <PolarisVizProvider>
                    <StackedAreaChart data={promotedSplit} theme="Light" />
                  </PolarisVizProvider>
                </div>
              )}
            </Fragment>
          </s-section>
        )}
        {/* [END campaign-dashboard.promoted-render] */}

        <Unavailable
          heading={`${tierLabel(campaign.audience)} segment sales`}
          reason={tierSales.unavailable}
        />

        {/* [START campaign-dashboard.tier-render] */}
        {/* The tier came from the app, the sales from the store. */}
        {tierRows.length > 0 && (
          <s-section id="audience-sales">
            <PanelHeader
              title={`${tierLabel(campaign.audience)} segment sales`}
              uses={{
                shopifyql:
                  "Filters the store's daily sales to the tier this campaign targeted.",
                metafields:
                  'Writes that tier onto each customer, which is what makes it queryable.',
              }}
            />
            <s-paragraph>
              {currency(tierTotal)} of {currency(totalSales)} came from the segment
              this campaign targeted, which is {tierShare.toFixed(0)}% of the
              store's sales over the same window.
            </s-paragraph>
            {isClient && (
              <div className="chart-tooltip-fix" style={{height: '220px'}}>
                <PolarisVizProvider>
                  <LineChart
                    data={[
                      {
                        name: tierLabel(campaign.audience),
                        data: tierRows.map((row) => ({
                          key: shortDate(row.day),
                          value: row.sales,
                        })),
                      },
                    ]}
                    theme="Light"
                  />
                </PolarisVizProvider>
              </div>
            )}
          </s-section>
        )}
        {/* [END campaign-dashboard.tier-render] */}

        <Unavailable
          heading="Order attribution"
          reason={touchSales.unavailable}
        />

        {/* [START campaign-dashboard.touch-render] */}
        {/* Per-order attribution splits revenue between the sends. */}
        {touchRows.length > 0 && (
          <s-section id="touch-sales">
            <PanelHeader
              title="Order attribution"
              uses={{
                shopifyql: "Groups the campaign's sales by the touch each order followed.",
                metafields:
                  'Writes that touch onto each order when the campaign closes.',
              }}
            />
            <s-paragraph>
              Each order carries the last campaign touch before it, written to{' '}
              <s-text type="strong">{dimensions.order.dimension}</s-text> when the
              campaign closed. The store groups its own sales by that column.
            </s-paragraph>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Campaign touch</s-table-header>
                <s-table-header listSlot="labeled">Orders</s-table-header>
                <s-table-header listSlot="labeled">Sales</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {touchRows.map((row) => (
                  <s-table-row key={row.touch}>
                    <s-table-cell>{row.touch}</s-table-cell>
                    <s-table-cell>{row.orders}</s-table-cell>
                    <s-table-cell>{currency(row.sales)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        )}
        {/* [END campaign-dashboard.touch-render] */}

        <Unavailable heading="Creator revenue" reason={codeSales.unavailable} />

        {/* [START campaign-dashboard.code-render] */}
        {/* What the codes prove against what the posts moved. */}
        {creatorRows.length > 0 && (
          <s-section id="creator-codes">
            <PanelHeader
              title="Creator revenue"
              uses={{
                shopifyql:
                  'Filters sales to the discount codes this campaign gave its creators.',
              }}
            />
            <s-paragraph>
              Code revenue comes from{' '}
              <s-text type="strong">discount_code</s-text>, which the store already
              has. Grouping several codes under one creator is the part only this app
              can do, because only it knows who hands out which code.
            </s-paragraph>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Creator</s-table-header>
                <s-table-header listSlot="secondary">Codes</s-table-header>
                <s-table-header listSlot="labeled">Orders</s-table-header>
                <s-table-header listSlot="labeled">Sales</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {creatorRows.map((row) => (
                  <s-table-row key={row.creator}>
                    <s-table-cell>{row.creator}</s-table-cell>
                    <s-table-cell>
                      {row.codes.map((entry) => entry.code).join(', ')}
                    </s-table-cell>
                    <s-table-cell>{row.orders}</s-table-cell>
                    <s-table-cell>{currency(row.sales)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {touchedTotal > 0 && (
              <s-paragraph>
                Codes were entered on {currency(codeTotal)}. Orders that followed a
                creator post without one bring the creators&rsquo; total to{' '}
                <s-text type="strong">{currency(touchedTotal)}</s-text>. The difference
                is what the codes couldn&rsquo;t prove.
              </s-paragraph>
            )}
          </s-section>
        )}
        {/* [END campaign-dashboard.code-render] */}

        {/* [START campaign-dashboard.close-render] */}
        {/* Closing rewrites the campaign's own marker rather than adding a second. */}
        {openCampaign && (
          <s-section heading="Closing this campaign">
            <s-paragraph>
              <s-text>{openCampaign.title}</s-text> sits on the store's charts as
              a span with no end. Closing it ends the span on{' '}
              {shortDate(closesOn)}, rewrites the title with what the campaign
              earned, and stamps each order with the last send that reached the
              customer before it. Until then, Order attribution has nothing to
              group.
            </s-paragraph>
            {running && (
              <s-button variant="primary" loading={busy} onClick={() => submit('close')}>
                Close the campaign with its result
              </s-button>
            )}
          </s-section>
        )}
        {/* [END campaign-dashboard.close-render] */}
        </Fragment>
      )}
    </s-page>
  );
}

// React Router replaces the nearest route with a boundary. Without one here, a failed
// load takes AppProvider and the app's navigation with it.
export function ErrorBoundary() {
  const error = useRouteError();
  const detail = error?.data ?? error?.message ?? 'The load failed.';
  return (
    <s-page heading="Campaign">
      <s-section>
        <s-banner tone="critical" heading="This campaign didn't load">
          <s-paragraph>{String(detail)}</s-paragraph>
        </s-banner>
        <s-box paddingBlockStart="base">
          <s-link href="/app/campaigns">Back to the campaign list</s-link>
        </s-box>
      </s-section>
    </s-page>
  );
}

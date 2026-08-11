import {Fragment, useEffect, useState} from 'react';
import {useFetcher, useLoaderData} from 'react-router';
import {
  BarChart,
  ComboChart,
  FunnelChartNext,
  LineChart,
  PolarisVizProvider,
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
  DEFINITION_CREATE,
  DEFINITION_QUERY,
  DEFINITION_UPDATE,
  METAFIELDS_SET,
  SHOP_QUERY,
  TARGETS_DELETE,
  TARGET_CREATE,
  TARGET_UPDATE,
  annotationsQuery,
  appEventsQuery,
  bounceQuery,
  crossAppQuery,
  emptyTable,
  insightQuery,
  measureQuery,
  progressQuery,
  progressValue,
  promotedByQuery,
  rosterQuery,
  runOptional,
  salesQuery,
  sequenceQuery,
  sliceQuery,
  targetsQuery,
  tierRankQuery,
  tierSalesQuery,
} from '../campaign-queries.server';
import {
  BOUNCE_ALERT_RATE,
  appNamespace,
  campaignMarks,
  campaignWindow,
  metafieldDimension,
  productId,
  promotedFilter,
  promotedNames,
} from '../campaigns';
import {CHANNELS, LIST_STAGES} from '../channels';
import {AUDIENCE_TIERS, TIER_METAFIELD, isTargetedTier, tierLabel} from '../audiences';
import {
  annotationColor,
  categoryLegend,
  categoryOf,
  exploreLink,
  exploreQuery,
} from '../annotations';
import {findInsight, ordinal} from '../insight';

// [START campaign-dashboard.metafield-dimension-read]
// The two definitions the app owns. `eligible` is whether the owner and field types
// can support a dimension, `enabled` is whether it's been asked for, and a definition
// is often the first without the second.
const DIMENSIONS = {
  product: {
    owner: 'products',
    ownerType: 'PRODUCT',
    key: 'promoted_by',
    name: 'Promoted by',
    description: 'The campaign that promoted this product.',
    // Merchants read this one and don't set it, because the app writes it at
    // launch and a hand-edited value would attribute sales to the wrong campaign.
    adminAccess: 'MERCHANT_READ',
  },
  customer: {
    owner: 'customers',
    ownerType: 'CUSTOMER',
    key: 'tier',
    name: 'Campaign tier',
    description: 'The audience tier this customer was last targeted in.',
    adminAccess: 'MERCHANT_READ_WRITE',
  },
};

async function readDimensions(admin, appId) {
  const body = await (
    await admin.graphql(DEFINITION_QUERY, {
      variables: {namespace: appNamespace(appId)},
    })
  ).json();

  const read = (which) => {
    const spec = DIMENSIONS[which];
    const node = body.data?.[spec.owner]?.nodes?.find(
      (definition) => definition.key === spec.key,
    );
    const capability = node?.capabilities?.analyticsQueryable;
    return {
      ...spec,
      defined: Boolean(node),
      eligible: Boolean(capability?.eligible),
      enabled: Boolean(capability?.enabled),
      dimension: metafieldDimension(which, appId, spec.key),
    };
  };

  return {product: read('product'), customer: read('customer')};
}
// [END campaign-dashboard.metafield-dimension-read]

// [START campaign-dashboard.slice-read]
// The same campaign sliced two ways. `campaign_id` is an attribute capped at 30 days,
// so it can't take the campaign's own window, while `app_name` is a property of the
// event and can. Both optional: no App Events data parses as an error, not empty rows.
const readComparisons = (admin, campaign) =>
  Promise.all([
    runOptional(admin, sliceQuery()),
    runOptional(admin, crossAppQuery(campaign)),
  ]);
// [END campaign-dashboard.slice-read]

export async function loader({request, params}) {
  // [START campaign-dashboard.campaign-load]
  // The record is the input to everything below it, and every query interpolates a
  // window a missing one wouldn't have. Treat that as a 404.
  const {admin} = await authenticate.admin(request);
  const {appId, campaigns} = await readCampaigns(admin);
  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) {
    throw new Response(`No campaign with ID ${params.campaignId}`, {
      status: 404,
    });
  }
  // [END campaign-dashboard.campaign-load]

  // [START campaign-dashboard.locale]
  // The admin's locale arrives as a search parameter on every embedded request.
  // Formatting on the server keeps the server and client renders identical.
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
    comparisons,
    promoted,
    tierSales,
    roster,
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
    readComparisons(admin, campaign),
    dimensions.product.enabled
      ? runOptional(admin, promotedByQuery(campaign, dimensions.product.dimension))
      : emptyTable(),
    dimensions.customer.enabled && isTargetedTier(campaign.audience)
      ? runOptional(
          admin,
          tierSalesQuery(campaign, dimensions.customer.dimension, campaign.audience),
        )
      : emptyTable(),
    campaign.members?.length ? runOptional(admin, rosterQuery(campaign)) : emptyTable(),
  ]);

  // [START campaign-dashboard.parse-errors]
  // Two failures in two places. A missing scope or ungranted protected customer data
  // access fails the field, so it lands in `errors` with a null `shopifyqlQuery`. A
  // string that doesn't parse resolves the field and reports on `parseErrors`.
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
  // Each target carries its own generated ShopifyQL, so measuring five targets takes
  // one request rather than five: alias each generated query in one document and read
  // the results back by position. A null `shopifyqlQuery` means the metric wasn't in
  // the store's schema list on this request, which is a condition of the request and
  // not of the target. Skip those rather than aliasing a null.
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
          ? `Shopify didn't return a query for ${target.metric} on this read, so its progress can't be measured yet. The target itself is still valid. Reload to try again.`
          : (progress[`t${index}`]?.parseErrors?.[0] ?? null),
    };
  });
  // [END campaign-dashboard.measure-targets]

  const [slice, crossApp] = comparisons;
  const annotations = annotationsBody.data?.shop?.analyticsAnnotations?.nodes ?? [];

  return {
    campaign,
    locale,
    fatal: null,
    appId,
    // The sales dataset has no currency column, so the store's own currency has
    // to come from the shop field the same query already asks for.
    currencyCode: salesBody.data?.shop?.currencyCode ?? 'USD',
    // The same field carries the store's timezone. ShopifyQL buckets a TIMESERIES by
    // it, so the browser's would date a marker to a day the chart doesn't have.
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
    slice,
    crossApp,
    promoted,
    tierSales,
    roster,
    insight: weekly.tableData.rows.length ? findInsight(weekly) : null,
  };
}

// [START campaign-dashboard.store-target]
// No filter, so it measures the whole store over the campaign's window. Metric, dates,
// and filters identify a target, so creating this twice is a user error. Return the ID:
// targets are shop-scoped, so only the app's own record knows which ones are its.
async function createTarget(admin, input) {
  const body = await (
    await admin.graphql(TARGET_CREATE, {variables: {input}})
  ).json();
  return body.data?.analyticsTargetCreate?.analyticsTarget?.id ?? null;
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
// A filter is ShopifyQL, not a label. `product_id IN (...)` is what separates "did the
// campaign sell what it advertised" from "did the store have a good fortnight".
async function createProductTarget(admin, campaign) {
  const filters = promotedFilter(campaign);
  if (!filters) return null;

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
// The same metric filtered on a dimension the app owns. Nothing on the target knows the
// metafield is the app's, so the filter quotes the reserved namespace in full. Skip it
// until the definition is queryable, or the generated query has no such column.
async function createAudienceTarget(admin, campaign, definition) {
  if (!isTargetedTier(campaign.audience)) return null;
  if (!definition.enabled) return null;

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
// A goal that's already been beaten stops telling anyone anything. Round the next one
// up from what the campaign earned, so $12,400 raises to $13,000 rather than $12,401.
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
// A bundle sells as one line and reports as its components, so a campaign that promoted
// one needs `bundle_launch`. Only the store's own data knows which it is.
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
    note: ` Sold as a bundle, so sales report against its components.`,
  };
}
// [END campaign-dashboard.bundle-mark]

// [START campaign-dashboard.product-metafield]
// Stamp each promoted product with the campaign that pushed it, so "which campaign sold
// this" is answerable later. `$app` resolves to the app's reserved namespace on write,
// and the field reads back as `app--<id>.promoted_by`.
const stampProducts = (admin, campaign) =>
  admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: campaign.products.map((product) => ({
        ownerId: product.id,
        namespace: '$app',
        key: 'promoted_by',
        type: 'single_line_text_field',
        value: campaign.title,
      })),
    },
  });
// [END campaign-dashboard.product-metafield]

// [START campaign-dashboard.stamp-tier]
// The audience the campaign targeted, written onto the customers themselves. The roster
// is saved on the record too: the metafield says the tier, not which campaign set it.
async function stampTier(admin, campaign) {
  const tier = AUDIENCE_TIERS.find((entry) => entry.value === campaign.audience);
  if (!tier?.size) return [];

  const body = await (await admin.graphql(tierRankQuery(tier))).json();
  // GROUP BY customer_id returns the numeric ID, and every mutation that follows
  // addresses a customer by GID, so rebuild the GID here rather than in each one.
  const ids = (body.data?.shopifyqlQuery?.tableData?.rows ?? [])
    .map((row) => row.customer_id)
    .filter(Boolean)
    .map((id) => `gid://shopify/Customer/${id}`);
  if (ids.length === 0) return [];

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
  });

  const names = await (
    await admin.graphql(CUSTOMER_NAMES, {variables: {ids}})
  ).json();
  return (names.data?.nodes ?? []).filter(Boolean).map((node) => ({
    id: node.id,
    displayName: node.displayName,
  }));
}
// [END campaign-dashboard.stamp-tier]

// [START campaign-dashboard.enable-dimension]
// Eligible isn't queryable: a definition has to be made a dimension explicitly, and
// until it is, every query naming it fails to parse. Create or update by key and owner
// type, because neither mutation takes an ID.
async function enableDimension(admin, definition) {
  const {ownerType} = definition;

  if (!definition.defined) {
    const body = await (
      await admin.graphql(DEFINITION_CREATE, {
        variables: {
          definition: {
            name: definition.name,
            description: definition.description,
            namespace: '$app',
            key: definition.key,
            type: 'single_line_text_field',
            ownerType,
            access: {admin: definition.adminAccess},
            capabilities: {analyticsQueryable: {enabled: true}},
          },
        },
      })
    ).json();
    return body.data?.metafieldDefinitionCreate?.userErrors ?? [];
  }

  const body = await (
    await admin.graphql(DEFINITION_UPDATE, {
      variables: {
        definition: {
          namespace: '$app',
          key: definition.key,
          ownerType,
          capabilities: {analyticsQueryable: {enabled: true}},
        },
      },
    })
  ).json();
  return body.data?.metafieldDefinitionUpdate?.userErrors ?? [];
}
// [END campaign-dashboard.enable-dimension]

// [START campaign-dashboard.set-products]
// Promoted products stay editable until launch, because the target filters on their IDs
// and the launch marker is named from their titles.
const setProducts = (admin, campaign, products) =>
  updateCampaign(admin, campaign.id, {products});
// [END campaign-dashboard.set-products]

// [START campaign-dashboard.audience-edit]
// The audience moves the tier written onto customers and the audience target's filter,
// so it's writable only while the campaign is still planned.
const setAudience = (admin, campaign, audience) =>
  updateCampaign(admin, campaign.id, {audience});
// [END campaign-dashboard.audience-edit]

// [START campaign-dashboard.close-with-outcome]
// Closing rewrites the campaign's own marker: `endedAt` moves from null to the last day
// and the title picks up the result, so the charts carry what happened.
async function closeCampaign(admin, campaign, text, endedAt) {
  const id = campaign.markers?.campaign;
  // No span means the launch never wrote one, and there's nothing to close. Say
  // so rather than returning no errors, which the action would read as success.
  if (!id) {
    return [{message: "This campaign has no span marker to close."}];
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
// The day a goal was hit is a moment rather than a span, so `endedAt` is left off
// entirely. Re-measure on the server, because the annotation outlives the session.
async function markMilestone(admin, target, markedAt) {
  const body = await (
    await admin.graphql(measureQuery(target.shopifyqlQuery))
  ).json();
  const actual = progressValue(body.data?.shopifyqlQuery);
  if (actual === null || actual < Number(target.expectedValue)) {
    return {userErrors: [{message: 'That goal has not been reached yet.'}]};
  }

  const created = await (
    await admin.graphql(ANNOTATION_CREATE, {
      variables: {
        input: {
          startedAt: markedAt,
          type: 'revenue_milestone',
          title: `${target.name} reached`,
          description: `Hit ${Math.round(actual)} against a goal of ${Math.round(
            Number(target.expectedValue),
          )}.`,
        },
      },
    })
  ).json();

  return created.data?.analyticsAnnotationCreate ?? {userErrors: []};
}
// [END campaign-dashboard.milestone]

// [START campaign-dashboard.record-mark]
// Every annotation the app writes goes on the record under a key, which is what lets a
// marker be rewritten later and is the exact set a cancel deletes. Milestones and
// incidents can repeat, so their keys carry what makes them distinct.
const recordMark = (admin, campaign, key, id) =>
  id ? rememberMarkers(admin, campaign.id, {[key]: id}) : null;
// [END campaign-dashboard.record-mark]

// [START campaign-dashboard.flag-incident]
// There's no bounce type in the annotation vocabulary, so it's written as `other` with
// the reason in the text. Detect it server-side: the client reports on data we can read.
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
// One action for every write, because they share three steps: read the record, do what
// the intent names, write it back. Launch is the only one that touches the store twice.
export async function action({request, params}) {
  const {admin} = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get('intent'));

  const [{appId, campaigns}, shopBody] = await Promise.all([
    readCampaigns(admin),
    admin.graphql(SHOP_QUERY).then((response) => response.json()),
  ]);
  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) throw new Response('Campaign not found', {status: 404});

  const shopId = shopBody.data?.shop?.id ?? null;
  const timeZone = shopBody.data?.shop?.ianaTimezone ?? 'Etc/UTC';

  // An annotation is timestamped in the shop's own day, not the browser's, so a marker
  // written at 11pm in Los Angeles for a store in Berlin belongs on the next day's
  // point. Read the timezone from the store rather than from the form.
  const markedAt = (date) =>
    new Date(shopMorning(date, timeZone)).toISOString();

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
  // Its own intent because the sequence is around 680 events and App Events has no batch
  // endpoint. A real app queues these as its own sends happen.
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
    // Accepted isn't ingested. The funnel stays empty for a few minutes after
    // this returns, so say so rather than letting the empty panel read as failure.
    return {ok: true, sentEvents: sent};
  }
  // [END campaign-dashboard.send-events-action]

  if (intent === 'enable-dimension') {
    const which = String(form.get('which'));
    const definition = dimensions[which];
    if (!definition) return {problems: [`No dimension named ${which}.`]};
    const errors = await enableDimension(admin, definition);
    return errors.length
      ? {problems: errors.map((error) => error.message)}
      : {ok: true};
  }

  if (intent === 'launch') {
    // Launching twice would duplicate the markers and the targets, and only the targets
    // would fail on uniqueness. Gate on the record's status: a goal the user set on the
    // same date isn't evidence that this campaign launched.
    if (campaign.status !== 'planned') {
      return {problems: ['This campaign has already been launched.']};
    }

    const launch = await resolveLaunchMark(admin, campaign);
    const markers = {};
    // Persist after each write, so a failure partway through leaves the record pointing
    // at what landed and a retry or a cancel can still finish.
    for (const mark of campaignMarks(campaign)) {
      const isLaunch = mark.key === 'launch';
      const body = await (
        await admin.graphql(ANNOTATION_CREATE, {
          variables: {
            input: {
              startedAt: markedAt(mark.date),
              // An omitted `endedAt` is a moment. An explicit null is a span
              // that hasn't finished.
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
        return {problems: created.userErrors.map((error) => error.message)};
      }
      if (created?.analyticsAnnotation?.id) {
        markers[mark.key] = created.analyticsAnnotation.id;
        await rememberMarkers(admin, campaign.id, {
          [mark.key]: created.analyticsAnnotation.id,
        });
      }
    }

    // Keep the ID of every target this app created. Targets aren't app-scoped, so the
    // saved set is the only way to cancel without touching a goal the user set.
    const [store, product, audience] = await Promise.all([
      createStoreTarget(admin, campaign),
      createProductTarget(admin, campaign),
      createAudienceTarget(admin, campaign, dimensions.customer),
    ]);
    const targets = {};
    for (const [key, id] of [
      ['store', store],
      ['product', product],
      ['audience', audience],
    ]) {
      if (id) targets[key] = id;
    }

    await stampProducts(admin, campaign);
    const members = await stampTier(admin, campaign);
    const {userErrors} = await updateCampaign(admin, campaign.id, {
      status: 'running',
      markers,
      targets,
      members,
    });
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'raise-target') {
    const targetsBody = await (
      await admin.graphql(targetsQuery(campaign))
    ).json();
    const target = (targetsBody.data?.analyticsTargets?.nodes ?? []).find(
      (node) => node.id === String(form.get('targetId')),
    );
    if (!target?.shopifyqlQuery) return {problems: ['That goal cannot be measured.']};

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
    if (!target) return {problems: ['That goal no longer exists.']};

    const result = await markMilestone(admin, target, markedAt(day));
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
    const [funnel, sequenceTable, targetsBody] = await Promise.all([
      runOptional(admin, appEventsQuery(campaign)),
      runOptional(admin, sequenceQuery(campaign)),
      admin.graphql(targetsQuery(campaign)).then((response) => response.json()),
    ]);

    const store = (targetsBody.data?.analyticsTargets?.nodes ?? []).find(
      (node) => !node.filters,
    );
    const measured = store?.shopifyqlQuery
      ? await (await admin.graphql(measureQuery(store.shopifyqlQuery))).json()
      : null;
    const revenue = progressValue(measured?.data?.shopifyqlQuery) ?? 0;

    const money = (value) =>
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: String(form.get('currency') || 'USD'),
        maximumFractionDigits: 0,
      }).format(value);

    const text = outcomeText({
      campaign,
      revenue,
      target: store?.expectedValue,
      sequence: readSequence(sequenceTable),
      money,
    });

    const errors = await closeCampaign(
      admin,
      campaign,
      text,
      markedAt(campaign.endDate),
    );
    if (errors.length) return {problems: errors.map((error) => error.message)};

    await updateCampaign(admin, campaign.id, {status: 'closed'});
    return {ok: true, funnelRows: funnel.tableData.rows.length};
  }

  if (intent === 'cancel') {
    // Delete exactly the IDs on the record. An annotation is app-scoped anyway, but
    // `analyticsTargetsDelete` will delete any target on the shop, so querying by date
    // and deleting the results would take the user's own goals with it.
    for (const id of Object.values(campaign.markers ?? {})) {
      await admin.graphql(ANNOTATION_DELETE, {variables: {id}});
    }

    const ids = Object.values(campaign.targets ?? {});
    if (ids.length > 0) {
      await admin.graphql(TARGETS_DELETE, {variables: {ids}});
    }

    // The metafields stay, and so does the event data. Canceling undoes the
    // annotations and the goals, and nothing else.
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

  return {problems: [`Unknown intent: ${intent}`]};
}
// [END campaign-dashboard.lifecycle]

// [START campaign-dashboard.unavailable-note]
// A panel with no rows because its query never ran looks the same as one with no rows
// because the store sold nothing, and only one is worth acting on. Pass a heading where
// the panel wouldn't otherwise render at all.
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
  // Polaris Viz measures the element it draws into, so it can't render on the server.
  // Gate every chart on a flag that turns true only after mount.
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);
  // [END campaign-dashboard.client-only]

  // [START campaign-dashboard.metric-card-ready]
  // A metric card reads through `window.shopify.shopifyQL`, which App Bridge installs
  // after load. Render before it lands and the card sits in an error state it never
  // leaves, so wait for the API rather than for the script tag.
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
    slice,
    crossApp,
    promoted,
    tierSales,
    roster,
    insight,
  } = data;

  // [START campaign-dashboard.read]
  // Every column comes back under the name ShopifyQL generated for it, and those names
  // are the contract. One helper, so a renamed column breaks in one place.
  const cell = (row, name) => row[name];
  // [END campaign-dashboard.read]

  // [START campaign-dashboard.format]
  // ShopifyQL returns money as a string so it doesn't lose precision. Format at the edge
  // and keep the raw value for anything compared or summed.
  const currency = (value) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(Number(value ?? 0));

  const integer = (value) =>
    new Intl.NumberFormat(locale).format(Number(value ?? 0));

  // A bare YYYY-MM-DD parses as UTC midnight, which renders as the day before
  // anywhere west of UTC. Appending a time makes it local.
  const asLocalDay = (day) => new Date(`${day}T00:00:00`);

  const shortDate = (day) =>
    new Intl.DateTimeFormat(locale, {month: 'short', day: 'numeric'}).format(
      asLocalDay(day),
    );

  const percent = (value) =>
    value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

  const humanize = (value) => String(value ?? '').replace(/_/g, ' ');

  // The app wrote this instant as 9am in the store's timezone, so slicing the UTC string
  // reports the day before east of UTC. `en-CA` formats a date as YYYY-MM-DD.
  const shopDay = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayOf = (instant) => shopDay.format(new Date(instant));
  // [END campaign-dashboard.format]

  // [START campaign-dashboard.totals]
  // WITH TOTALS and COMPARE TO each put their value on a generated column named after
  // the metric, so these names are derived rather than chosen.
  const totalSales = rows[0]?.['total_sales__totals'] ?? '0';
  const previousTotal = Number(
    rows[0]?.['comparison_total_sales__previous_period__totals'] ?? 0,
  );
  const percentChange =
    previousTotal === 0
      ? null
      : ((Number(totalSales) - previousTotal) / Math.abs(previousTotal)) * 100;
  // [END campaign-dashboard.totals]

  // [START campaign-dashboard.goal-copy]
  // A target's `filters` is ShopifyQL, and showing it reads as a leaked internal. Say
  // what it narrows to, and fall back to the expression only when the record can't.
  function goalScope(target) {
    if (!target.filters) return 'Everything the store sold';
    if (target.filters.startsWith('product_id')) {
      const names = promotedNames(campaign);
      return names ? `Sales of ${names}` : 'Sales of the promoted products';
    }
    if (target.filters.includes(dimensions.customer.key)) {
      return `Sales to ${tierLabel(campaign.audience).toLowerCase()}`;
    }
    return `Filtered by ${target.filters}`;
  }
  // [END campaign-dashboard.goal-copy]

  // [START campaign-dashboard.target-split]
  // The store-wide goal is the one without a filter, and it's the number the campaign
  // gets judged on. Everything else is a slice of it, so rank them below rather than beside.
  const storeTarget = targets.find((target) => !target.filters) ?? null;
  const scopedTargets = targets.filter((target) => target.filters);
  // [END campaign-dashboard.target-split]

  // [START campaign-dashboard.annotations-overlay]
  // Split the store's annotations by who wrote them: this app's are the ones it can
  // update and delete. Grey the rest so the chart doesn't imply the app put them there.
  const ours = annotations.filter(
    (annotation) => annotation.createdByApp?.id === appId,
  );
  const others = annotations.filter(
    (annotation) => annotation.createdByApp?.id !== appId,
  );

  // Polaris Viz matches an annotation to a point by the axis label it drew, not by
  // the value in the data, so the key is the formatted day and not the timestamp.
  const chartAnnotations = annotations.map((annotation) => ({
    startKey: shortDate(dayOf(annotation.startedAt)),
    label: annotation.title,
    content: {
      content: annotation.description ?? annotation.title,
      linkUrl: undefined,
    },
    axis: 'x',
    color: annotationColor(annotation, appId),
  }));

  const openCampaign = ours.find((annotation) => !annotation.endedAt) ?? null;
  // Read off the record, not off what's in view. The annotations read is windowed and
  // any `other` marker satisfies it, so one dated outside the window offers a duplicate.
  const incidentFlagged = Object.keys(campaign.markers ?? {}).some((key) =>
    key.startsWith('incident:'),
  );
  const legend = categoryLegend(annotations, appId);
  // [END campaign-dashboard.annotations-overlay]

  // The same conditions the launch itself applies: a product target needs promoted
  // products, and an audience target needs both a real tier and a queryable dimension.
  const plannedTargetCount =
    1 +
    (campaign.products.length > 0 ? 1 : 0) +
    (isTargetedTier(campaign.audience) && dimensions.customer.enabled ? 1 : 0);

  // [START campaign-dashboard.timeline]
  // Two annotations on the same day are two dots in one position, so group by day and
  // let one dot carry both. The busiest day decides how tall the strip has to be.
  const byDay = new Map();
  for (const annotation of annotations) {
    const day = dayOf(annotation.startedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(annotation);
  }
  const timelineDays = [...byDay.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const busiestDay = Math.max(1, ...timelineDays.map(([, list]) => list.length));

  const windowStart = asLocalDay(campaign.startDate).getTime();
  const windowSpan = Math.max(
    1,
    (asLocalDay(campaign.endDate).getTime() - windowStart) / 86400000,
  );
  const dayOffset = (day) =>
    ((asLocalDay(day).getTime() - windowStart) / 86400000 / windowSpan) * 100;
  // [END campaign-dashboard.timeline]

  // [START campaign-dashboard.chart]
  // Sales are money and orders are a count, so they can't share an axis, and a
  // ComboChart is the shape that admits it. The annotations ride on the shared x-axis.
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
  // `s-metrics-bar-date-picker` reports the alias it was set to and nothing else, so the
  // app owns the translation from `last30days` to a SINCE and rebuilds each query.
  const since = SINCE_BY_RANGE[range];
  const cardQuery = (metric) =>
    [
      'FROM sales',
      `SHOW ${metric}`,
      'TIMESERIES day',
      `SINCE ${since} UNTIL today`,
      'WITH TOTALS, PERCENT_CHANGE',
      'COMPARE TO previous_period',
      `VISUALIZE ${metric} TYPE line`,
    ].join(' ');
  // [END campaign-dashboard.metric-card]

  // [START campaign-dashboard.funnel-totals]
  // A daily timeseries has one row per day, so a campaign total is a column summed
  // rather than a value read. The rates below are the point of the panel.
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
  const captured = total('leads_captured');

  const health = {
    bounceRate: rate(bounced, total('emails_sent')),
    unsubRate: rate(unsubscribed, reached),
    reach: rate(reached, sent),
    netList: captured - unsubscribed,
  };
  // [END campaign-dashboard.funnel-totals]

  // [START campaign-dashboard.channel-funnels]
  // Each channel reports a different set of stages, so each gets its own funnel: push
  // has no delivery at all, and comparing its middle to email's would compare a send to
  // a delivery. A channel whose first stage is zero didn't send.
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

  const listFunnel = LIST_STAGES.map((stage) => [
    stage.label,
    total(stage.metric),
  ]);
  // [END campaign-dashboard.channel-funnels]

  // [START campaign-dashboard.sends-by-day]
  // The same rows the funnel totalled, kept as a series. Sends by day beside sales by
  // day is what shows whether the days the campaign pushed are the days the store sold.
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
  // How many people each touch reached, and whether the share engaging fell as the
  // campaign kept sending. Falling engagement across a sequence is fatigue.
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

  // [START campaign-dashboard.slice-shape]
  // Splitting by campaign puts this one next to the others the app has run. The window
  // is the attribute's 30 days rather than the campaign's, so label it that way.
  const sliceRows = (slice.tableData.rows ?? [])
    .map((row) => ({
      id: String(cell(row, 'campaign_id') ?? ''),
      sent: Number(cell(row, 'emails_sent') ?? 0),
      opened: Number(cell(row, 'emails_opened') ?? 0),
      mine: String(cell(row, 'campaign_id')) === String(campaign.id),
    }))
    .filter((row) => row.id && row.sent > 0)
    .map((row) => ({...row, rate: rate(row.opened, row.sent)}))
    .sort((a, b) => b.rate - a.rate);
  // [END campaign-dashboard.slice-shape]

  // [START campaign-dashboard.cross-app-rows]
  // Every app that reported an event in this window, this one included. The store sees
  // all of them, so showing only its own tells the merchant less than the admin does.
  const crossAppRows = (crossApp.tableData.rows ?? [])
    .map((row) => ({
      app: String(cell(row, 'app_name') ?? 'Unnamed'),
      // Every send the app reported, not only its email. An app that sends on one channel
      // would drop out of the comparison if this counted a column it never reports.
      sent:
        Number(cell(row, 'emails_sent') ?? 0) +
        Number(cell(row, 'sms_messages_sent') ?? 0) +
        Number(cell(row, 'push_notifications_sent') ?? 0),
    }))
    .filter((row) => row.sent > 0)
    .sort((a, b) => b.sent - a.sent);
  // [END campaign-dashboard.cross-app-rows]

  // [START campaign-dashboard.insight-chart]
  // The weekly run with the campaign's markers on it. Two markers in one week land on
  // the same point, so merge them rather than stacking labels the chart will overlap.
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
        label: list.length === 1 ? list[0].title : `${list.length} markers`,
        content: {content: list.map((entry) => entry.title).join('. ')},
        axis: 'x',
        color: annotationColor(list[0], appId),
      });
    }
  }
  // [END campaign-dashboard.insight-chart]

  // [START campaign-dashboard.analytics-link]
  // Hand off to the store's own explorer with the query already in it, built from the
  // types the app wrote, so the markers on the app's chart are the markers on theirs.
  const exploreHref = exploreLink(
    exploreQuery({
      window: queryWindow,
      types: ours.map((annotation) => annotation.type),
    }),
  );
  // [END campaign-dashboard.analytics-link]

  // [START campaign-dashboard.promoted-split]
  // What the campaign promoted against what the store sold anyway, read back through
  // the store's analytics rather than out of the app's database. The column is the
  // query's alias, and products no campaign stamped come back under an empty value.
  const promotedRows = (promoted.tableData.rows ?? [])
    .map((row) => ({
      title: String(cell(row, 'promoted_by') ?? ''),
      sales: Number(cell(row, 'total_sales') ?? 0),
    }))
    .filter((row) => row.title !== '');
  const promotedSales = promotedRows
    .filter((row) => row.title === campaign.title)
    .reduce((running, row) => running + row.sales, 0);
  const promotedShare = rate(promotedSales, Number(totalSales));
  // [END campaign-dashboard.promoted-split]

  // [START campaign-dashboard.tier-shape]
  // A tier the app wrote onto customers is a dimension like any other once it's
  // queryable, so the answer comes back from the store's sales data.
  const tierRows = (tierSales.tableData.rows ?? []).map((row) => ({
    day: String(cell(row, 'day')),
    sales: Number(cell(row, 'total_sales') ?? 0),
  }));
  const tierTotal = tierRows.reduce((running, row) => running + row.sales, 0);
  const tierShare = rate(tierTotal, Number(totalSales));
  // [END campaign-dashboard.tier-shape]

  // [START campaign-dashboard.member-join]
  // The roster the app saved at launch, joined to what each member spent. The metafield
  // says the tier and not which campaign set it, so the record is what names this set.
  const spendById = new Map(
    (roster.tableData.rows ?? []).map((row) => [
      String(cell(row, 'customer_id') ?? ''),
      Number(cell(row, 'total_sales') ?? 0),
    ]),
  );
  const members = (campaign.members ?? [])
    .map((member) => ({
      ...member,
      spend: spendById.get(productId(member.id)) ?? 0,
    }))
    .sort((a, b) => b.spend - a.spend);
  // [END campaign-dashboard.member-join]

  // [START campaign-dashboard.supply-context]
  // Two annotation types the app can read and can't write. Either one inside the window
  // is a competing explanation for whatever the sales chart did.
  const supplyTypes = ['supplier_change', 'fulfillment_service_change'];
  const supplyMarks = others.filter((annotation) =>
    supplyTypes.includes(annotation.type),
  );
  // [END campaign-dashboard.supply-context]

  // [START campaign-dashboard.advice]
  // The part that says what to do about the numbers. Every line is gated on a threshold,
  // because advice that appears whatever the data says isn't advice. A marker's effect is
  // the average of the days on each side, not the total.
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

  const advice = [];

  if (storeTarget?.percent >= 100) {
    advice.push(
      `The store-wide goal is at ${storeTarget.percent}% with the window still open. Raise it so it keeps meaning something.`,
    );
  } else if (storeTarget?.percent !== null && storeTarget?.percent < 60) {
    advice.push(
      `The store-wide goal is at ${storeTarget.percent}%. ${currency(
        Number(storeTarget.expectedValue) - Number(storeTarget.actual ?? 0),
      )} of it is still unearned.`,
    );
  }

  if (health.bounceRate >= BOUNCE_ALERT_RATE * 100) {
    advice.push(
      `${health.bounceRate.toFixed(
        1,
      )}% of emails bounced. Clean the list before the next send, because deliverability carries between campaigns.`,
    );
  }

  if (fatigue?.falling && fatigue.from - fatigue.to >= 10) {
    advice.push(
      `Engagement fell from ${Math.round(fatigue.from)}% to ${Math.round(
        fatigue.to,
      )}% across ${fatigue.touches} touches. The sequence is one or two sends too long.`,
    );
  }

  if (health.netList < 0) {
    advice.push(
      `The campaign cost the list ${Math.abs(
        health.netList,
      )} contacts. It earned money and shrank the audience for the next one.`,
    );
  }

  if (promotedRows.length > 0 && promotedShare < 25) {
    advice.push(
      `The promoted products are ${promotedShare.toFixed(
        0,
      )}% of what sold. The campaign lifted the store more than it lifted its own products.`,
    );
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
      advice.push(
        `Daily sales ${lift > 0 ? 'averaged' : 'fell to'} ${currency(
          launchEffect.after,
        )} after the launch against ${currency(
          launchEffect.before,
        )} before it, a ${Math.abs(lift).toFixed(0)}% ${
          lift > 0 ? 'lift' : 'drop'
        }.`,
      );
    }
  }

  if (supplyMarks.length > 0) {
    advice.push(
      `${supplyMarks.length} supply-side change${
        supplyMarks.length === 1 ? '' : 's'
      } landed inside this window. Read the result against that before crediting the campaign.`,
    );
  }
  // [END campaign-dashboard.advice]

  const problems = fetcher.data?.problems ?? [];
  const busy = fetcher.state !== 'idle';
  const today = dayOf(Date.now());

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

  return (
    <s-page heading={campaign.title}>
      {problems.length > 0 && (
        <s-section>
          <s-banner tone="critical" heading="That didn't go through">
            <s-unordered-list>
              {problems.map((problem) => (
                <s-list-item key={problem}>{problem}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        </s-section>
      )}

      {/* [START campaign-dashboard.status-render] */}
      {/* Which writes are offered follows the campaign's state: one that hasn't
          launched has nothing to close, and a closed one has nothing left to mark. */}
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge
            tone={running ? 'success' : campaign.status === 'closed' ? 'info' : undefined}
          >
            {campaign.status}
          </s-badge>
          <s-text tone="subdued">
            {shortDate(campaign.startDate)} to {shortDate(campaign.endDate)}
          </s-text>
          <s-text tone="subdued">
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
          {campaign.status !== 'canceled' && (
            <s-button tone="critical" loading={busy} onClick={() => submit('cancel')}>
              Cancel the campaign
            </s-button>
          )}
        </s-stack>
      </s-section>
      {/* [END campaign-dashboard.status-render] */}

      {/* [START campaign-dashboard.incident-banner] */}
      {/* Writing a problem to the store's charts is what makes it visible to
          someone who never opens this app, so the button says that. */}
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
              . The store's analytics won't show this unless the app puts it there.
            </s-paragraph>
            {incidentFlagged ? (
              <s-text tone="subdued">Already marked on the store's charts.</s-text>
            ) : (
              <s-button
                loading={busy}
                onClick={() => submit('flag-incident', {day: today})}
              >
                Add a marker to the store's analytics
              </s-button>
            )}
          </s-banner>
        </s-section>
      )}
      {/* [END campaign-dashboard.incident-banner] */}

      {planned && (
        <Fragment>
          {/* [START campaign-dashboard.setup-render] */}
          {/* Everything the launch will write, listed before it writes it. Products
              and audience stay editable until then because the targets filter on them. */}
          <s-section heading="What launching will do">
            <s-unordered-list>
              <s-list-item>
                Write {campaignMarks(campaign).length} annotations to the store's
                analytics, one of them an open span for the campaign itself.
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
                  ? ` and tag the ${tierLabel(campaign.audience).toLowerCase()} audience.`
                  : '. This audience covers the whole store, so no customer is tagged.'}
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
                  label="Audience"
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
          {/* [END campaign-dashboard.setup-render] */}

          {/* [START campaign-dashboard.planned-goals] */}
          {/* The three goals as typed, before any is a target. Each measures a
              different question, so show its filter rather than three rows of money. */}
          <s-section heading="Goals this campaign will be measured on">
            <s-table>
              <s-table-header-row>
                <s-table-header>Goal</s-table-header>
                <s-table-header>Measures</s-table-header>
                <s-table-header>Amount</s-table-header>
              </s-table-header-row>
              <s-table-body>
                <s-table-row>
                  <s-table-cell>Store-wide</s-table-cell>
                  <s-table-cell>Everything the store sold</s-table-cell>
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
                    <s-table-cell>Audience</s-table-cell>
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
          {/* [END campaign-dashboard.planned-goals] */}
        </Fragment>
      )}

      {/* [START campaign-dashboard.advice-render] */}
      {/* Nothing here appears unless its threshold was crossed, so an empty list
          means the campaign is running as it should. */}
      {advice.length > 0 && (
        <s-section heading="What this campaign is telling you">
          <s-unordered-list>
            {advice.map((line) => (
              <s-list-item key={line}>{line}</s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      )}
      {/* [END campaign-dashboard.advice-render] */}

      {/* [START campaign-dashboard.card-render] */}
      {/* Three numbers the app doesn't calculate. The date picker reports the range
          it was set to and the app rebuilds each query from it. Wait for the
          ShopifyQL API, or the cards mount into an error state they never leave. */}
      <s-section heading="The store, straight from analytics">
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

      <Unavailable
        heading="The store's weekly trend"
        reason={weekly.unavailable}
      />

      {/* [START campaign-dashboard.insight-render] */}
      {/* A run of weeks is a finding. A single week's number is a reading. */}
      {insight && isClient && (
        <s-section>
          <s-stack direction="block" gap="small-200">
            <s-text tone="subdued">
              Insight, {shortDate(insight.settledWeek)}
            </s-text>
            <s-heading>
              {insight.title} {insight.rising ? 'is up' : 'is down'} for the{' '}
              {ordinal(insight.streak)} week running
            </s-heading>
            {insight.growth !== null && (
              <s-paragraph>
                {currency(insight.first)} to {currency(insight.latest)}, a{' '}
                {Math.abs(insight.growth)}%{' '}
                {insight.rising ? 'increase' : 'decrease'} over{' '}
                {insight.streak} weeks.
              </s-paragraph>
            )}
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
            {showMarks ? 'Hide the markers' : 'List the markers'}
          </s-button>
        </s-section>
      )}
      {/* [END campaign-dashboard.insight-render] */}

      <s-section heading="Sales and orders over the campaign">
        <s-stack direction="inline" gap="large">
          <s-stack direction="block" gap="small-500">
            <s-text tone="subdued">Total sales</s-text>
            <s-heading>{currency(totalSales)}</s-heading>
            <s-text tone={percentChange === null ? 'subdued' : percentChange >= 0 ? 'success' : 'critical'}>
              {percent(percentChange)} against the previous period
            </s-text>
          </s-stack>
        </s-stack>

        {isClient && (
          <div className="chart-tooltip-fix" style={{height: '320px'}}>
            <PolarisVizProvider>
              <ComboChart
                series={[
                  {
                    shape: 'Bar',
                    data: sends.length > 0 ? sends : [ordersSeries],
                  },
                  {shape: 'Line', data: [salesSeries]},
                ]}
                annotations={chartAnnotations}
                theme="Light"
              />
            </PolarisVizProvider>
          </div>
        )}

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
              <s-text tone="subdued">
                {entry.label} ({entry.count})
              </s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      {/* [START campaign-dashboard.target-render] */}
      {/* Show the share reached rather than the two amounts, and offer the two
          things a user can do: mark the day it was hit, or move a beaten goal. */}
      {targets.length > 0 && (
        <s-section heading="Goals">
          {storeTarget && (
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-heading>{storeTarget.name}</s-heading>
                <s-badge
                  icon={
                    storeTarget.percent !== null && storeTarget.percent >= 100
                      ? 'check-circle'
                      : 'clock'
                  }
                  tone={
                    storeTarget.percent !== null && storeTarget.percent >= 100
                      ? 'success'
                      : undefined
                  }
                >
                  {storeTarget.percent === null
                    ? 'Not measured'
                    : `${storeTarget.percent}%`}
                </s-badge>
              </s-stack>

              <s-text tone="subdued">
                {goalScope(storeTarget)}. {currency(storeTarget.actual ?? 0)} of{' '}
                {currency(storeTarget.expectedValue)}.
              </s-text>

              {storeTarget.queryError && (
                <s-banner tone="warning">
                  <s-paragraph>{storeTarget.queryError}</s-paragraph>
                </s-banner>
              )}

              {/* App Home has no progress bar, so this is a labelled div on the page's tokens. */}
              <div
                role="progressbar"
                aria-valuenow={storeTarget.percent ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${storeTarget.name} progress`}
                style={{
                  height: '8px',
                  borderRadius: '4px',
                  background: 'var(--s-color-bg-fill-secondary)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, storeTarget.percent ?? 0)}%`,
                    height: '100%',
                    background:
                      (storeTarget.percent ?? 0) >= 100
                        ? 'var(--s-color-bg-fill-success)'
                        : 'var(--s-color-bg-fill-brand)',
                  }}
                />
              </div>

              {running && (
                <s-stack direction="inline" gap="base">
                  {storeTarget.percent !== null && storeTarget.percent >= 100 && (
                    <Fragment>
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
                        Raise the goal
                      </s-button>
                    </Fragment>
                  )}
                </s-stack>
              )}
            </s-stack>
          )}

          {scopedTargets.length > 0 && (
            <s-table>
              <s-table-header-row>
                <s-table-header>Goal</s-table-header>
                <s-table-header>Measures</s-table-header>
                <s-table-header>Reached</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {scopedTargets.map((target) => (
                  <s-table-row key={target.id}>
                    <s-table-cell>{target.name}</s-table-cell>
                    <s-table-cell>{goalScope(target)}</s-table-cell>
                    <s-table-cell>
                      {target.percent === null
                        ? (target.queryError ?? 'Not measured')
                        : `${target.percent}% of ${currency(
                            target.expectedValue,
                          )}`}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}
      {/* [END campaign-dashboard.target-render] */}

      {/* [START campaign-dashboard.close-render] */}
      {/* Closing rewrites the campaign's own marker rather than adding a second,
          so the store's charts carry the result and not a plan beside a result. */}
      {openCampaign && (
        <s-section heading="The campaign's own marker">
          <s-paragraph>
            <s-text>{openCampaign.title}</s-text> has been on the store's charts
            since {shortDate(dayOf(openCampaign.startedAt))} with no end
            date. Closing the campaign moves its end to{' '}
            {shortDate(campaign.endDate)} and rewrites the title with what it
            earned.
          </s-paragraph>
          {running && (
            <s-button variant="primary" loading={busy} onClick={() => submit('close')}>
              Close the campaign with its result
            </s-button>
          )}
        </s-section>
      )}
      {/* [END campaign-dashboard.close-render] */}

      {/* [START campaign-dashboard.timeline-render] */}
      {/* The chart shows where the markers landed. This shows what they were,
          which a chart with eight annotations on it can't carry. */}
      <s-section heading="Markers in this window">
        <div
          style={{
            position: 'relative',
            height: `${busiestDay * 28 + 20}px`,
            borderTop: '1px solid var(--s-color-border)',
            marginTop: '12px',
          }}
        >
          {timelineDays.map(([, list]) =>
            list.map((annotation) => (
              <s-tooltip key={annotation.id} id={`tip-${annotation.id}`}>
                {annotation.description ?? annotation.title}
              </s-tooltip>
            )),
          )}
          {timelineDays.map(([day, list]) =>
            list.map((annotation, index) => (
              <s-clickable
                key={`dot-${annotation.id}`}
                interestFor={`tip-${annotation.id}`}
                accessibilityLabel={`${annotation.title} on ${shortDate(day)}`}
                style={{
                  position: 'absolute',
                  left: `${Math.min(98, Math.max(0, dayOffset(day)))}%`,
                  top: `${index * 28 + 8}px`,
                }}
              >
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <div
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      backgroundColor: annotationColor(annotation, appId),
                    }}
                  />
                  <s-text tone="subdued">{annotation.title}</s-text>
                </s-stack>
              </s-clickable>
            )),
          )}
        </div>

        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            The same window, the same markers, in the store's own explorer.
          </s-paragraph>
          <s-box padding="base" background="subdued" borderRadius="base">
            <pre style={{margin: 0, whiteSpace: 'pre-wrap'}}>
              {exploreQuery({
                window: queryWindow,
                types: ours.map((annotation) => annotation.type),
              })}
            </pre>
          </s-box>
          <s-link href={exploreHref} target="_blank">
            Open these weeks in the store's analytics
          </s-link>
        </s-stack>
      </s-section>
      {/* [END campaign-dashboard.timeline-render] */}

      {/* [START campaign-dashboard.marks-render] */}
      {/* What the app wrote, and what it can still do to each one. A span shows its
          end date or that it hasn't one, which is finished against still running. */}
      {ours.length > 0 && (
        <s-section heading="Markers this app wrote">
          <s-table>
            <s-table-header-row>
              <s-table-header>Marker</s-table-header>
              <s-table-header>Category</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {ours.map((annotation) => (
                <s-table-row key={annotation.id}>
                  <s-table-cell>{annotation.title}</s-table-cell>
                  <s-table-cell>{humanize(categoryOf(annotation.type))}</s-table-cell>
                  <s-table-cell>
                    {shortDate(dayOf(annotation.startedAt))}
                    {annotation.endedAt
                      ? ` to ${shortDate(dayOf(annotation.endedAt))}`
                      : annotation.endedAt === null && annotation.type === 'campaign'
                        ? ' onwards'
                        : ''}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
      {/* [END campaign-dashboard.marks-render] */}

      {/* [START campaign-dashboard.confounders] */}
      {/* Markers this app didn't write. A price or supplier change inside the window
          is a competing explanation, and the merchant sees it either way. */}
      {others.length > 0 && (
        <s-section heading="Other things that happened in this window">
          <s-paragraph>
            {others.length} marker{others.length === 1 ? '' : 's'} from outside this
            app landed inside the campaign's dates.
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>Marker</s-table-header>
              <s-table-header>Written by</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {others.map((annotation) => (
                <s-table-row key={annotation.id}>
                  <s-table-cell>{annotation.title}</s-table-cell>
                  <s-table-cell>
                    {annotation.createdByApp?.title ?? 'Shopify'}
                  </s-table-cell>
                  <s-table-cell>
                    {shortDate(dayOf(annotation.startedAt))}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
      {/* [END campaign-dashboard.confounders] */}

      {/* [START campaign-dashboard.send-events-render] */}
      {/* The only panel that writes to App Events rather than reading analytics.
          Nothing below has data until these exist, and ingestion isn't immediate. */}
      {(funnel.tableData.rows ?? []).length === 0 && (
        <s-section heading="The campaign's events">
          {funnel.unavailable ? (
            <s-banner tone="info">
              <s-paragraph>
                This store can't query App Events yet: {funnel.unavailable}
              </s-paragraph>
            </s-banner>
          ) : (
            <Fragment>
              <s-paragraph>
                Replay this campaign's sends as App Events: nine touches across
                email, SMS, and push, plus the forms that grew the list. It's
                around 680 events, and App Events takes one request each, so the
                send runs for a minute or two.
              </s-paragraph>
              <s-paragraph>
                Shopify accepts an event before it ingests it, so the funnels stay
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
      {/* One funnel per channel, because each reports a different set of stages and
          one chart would compare a send to a delivery. */}
      {isClient && funnels.length > 0 && (
        <s-section heading="What each channel did">
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
                        theme="Light"
                      />
                    </PolarisVizProvider>
                  </div>
                </s-grid-item>
              ))}
              {listFunnel[0][1] > 0 && (
                <s-grid-item>
                  <s-heading>List growth</s-heading>
                  <div style={{height: '220px'}}>
                    <PolarisVizProvider>
                      <FunnelChartNext
                        data={[
                          {
                            name: 'List',
                            data: listFunnel.map(([key, value]) => ({
                              key,
                              value,
                            })),
                          },
                        ]}
                        theme="Light"
                      />
                    </PolarisVizProvider>
                  </div>
                </s-grid-item>
              )}
            </s-grid>
          </s-query-container>
        </s-section>
      )}
      {/* [END campaign-dashboard.funnel-render] */}

      {/* [START campaign-dashboard.app-events-render] */}
      {/* Reach falls because lists shrink. Engagement falling across the sequence
          is fatigue, and it's the one finding here the merchant can act on. */}
      {sequence.length > 0 && (
        <s-section heading="The sequence, touch by touch">
          {isClient && (
            <div className="chart-tooltip-fix" style={{height: '280px'}}>
              <PolarisVizProvider>
                <ComboChart
                  series={[
                    {shape: 'Bar', data: sequenceBars},
                    {shape: 'Line', data: sequenceRate},
                  ]}
                  theme="Light"
                />
              </PolarisVizProvider>
            </div>
          )}

          {fatigue && (
            <s-paragraph>
              Engagement {fatigue.falling ? 'fell' : 'rose'} from{' '}
              {Math.round(fatigue.from)}% on the first touch to{' '}
              {Math.round(fatigue.to)}% on the last, across {fatigue.touches}{' '}
              sends. The weakest was {fatigue.worst.name} at{' '}
              {Math.round(fatigue.worst.rate)}%, and {integer(fatigue.lost)}{' '}
              people unsubscribed along the way.
            </s-paragraph>
          )}

          <s-table>
            <s-table-header-row>
              <s-table-header>Touch</s-table-header>
              <s-table-header>Sent</s-table-header>
              <s-table-header>Reached</s-table-header>
              <s-table-header>Engaged</s-table-header>
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
      {/* A campaign can earn money and still cost more contacts than it captured,
          which is a result the sales chart can't show. */}
      {sent > 0 && (
        <s-section heading="What it cost the list">
          <s-stack direction="inline" gap="large">
            <s-stack direction="block" gap="small-500">
              <s-text tone="subdued">Reached</s-text>
              <s-heading>{health.reach.toFixed(1)}%</s-heading>
              <s-text tone="subdued">
                {integer(reached)} of {integer(sent)} sends
              </s-text>
            </s-stack>
            <s-stack direction="block" gap="small-500">
              <s-text tone="subdued">Bounced</s-text>
              <s-heading>{health.bounceRate.toFixed(1)}%</s-heading>
              <s-text tone="subdued">{integer(bounced)} emails</s-text>
            </s-stack>
            <s-stack direction="block" gap="small-500">
              <s-text tone="subdued">Unsubscribed</s-text>
              <s-heading>{health.unsubRate.toFixed(1)}%</s-heading>
              <s-text tone="subdued">{integer(unsubscribed)} contacts</s-text>
            </s-stack>
            <s-stack direction="block" gap="small-500">
              <s-text tone="subdued">Net list change</s-text>
              <s-heading>
                {health.netList >= 0 ? '+' : ''}
                {integer(health.netList)}
              </s-heading>
              <s-text tone="subdued">
                {integer(captured)} captured, {integer(unsubscribed)} lost
              </s-text>
            </s-stack>
          </s-stack>

          <Unavailable reason={slice.unavailable} />
          <Unavailable reason={crossApp.unavailable} />

          {sliceRows.length > 1 && (
            <Fragment>
              <s-paragraph>
                Every campaign this app reported on over the last 30 days. The
                attribute's window is capped, so this is not the campaign's own
                window.
              </s-paragraph>
              <s-table>
                <s-table-header-row>
                  <s-table-header>Campaign</s-table-header>
                  <s-table-header>Sent</s-table-header>
                  <s-table-header>Opened</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {sliceRows.map((row) => (
                    <s-table-row key={row.id}>
                      <s-table-cell>
                        {row.mine ? `${campaign.title} (this one)` : `Campaign ${row.id}`}
                      </s-table-cell>
                      <s-table-cell>{integer(row.sent)}</s-table-cell>
                      <s-table-cell>{row.rate.toFixed(1)}%</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </Fragment>
          )}

          {crossAppRows.length > 1 && (
            <Fragment>
              <s-paragraph>
                Every app that reported an event in this window. The store sees all
                of them.
              </s-paragraph>
              <s-table>
                <s-table-header-row>
                  <s-table-header>App</s-table-header>
                  <s-table-header>Sent</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {crossAppRows.map((row) => (
                    <s-table-row key={row.app}>
                      <s-table-cell>{row.app}</s-table-cell>
                      <s-table-cell>{integer(row.sent)}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </Fragment>
          )}
        </s-section>
      )}
      {/* [END campaign-dashboard.reach-render] */}

      {/* [START campaign-dashboard.metafield-dimension-render] */}
      {/* A metafield the app owns is a dimension only once it's been asked for, and
          until then every query naming it fails to parse. Do the asking from here. */}
      <s-section heading="Dimensions this app owns">
        <s-table>
          <s-table-header-row>
            <s-table-header>Dimension</s-table-header>
            <s-table-header>State</s-table-header>
            <s-table-header />
          </s-table-header-row>
          <s-table-body>
            {['product', 'customer'].map((which) => {
              const definition = dimensions[which];
              return (
                <s-table-row key={which}>
                  <s-table-cell>
                    <s-text>{definition.dimension}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {definition.enabled
                      ? 'Queryable'
                      : !definition.defined
                        ? 'Not created yet'
                        : definition.eligible
                          ? 'Created, not yet queryable'
                          : 'Not eligible. Check the field type and owner type.'}
                  </s-table-cell>
                  <s-table-cell>
                    {!definition.enabled &&
                      (!definition.defined || definition.eligible) && (
                        <s-button
                          loading={busy}
                          onClick={() => submit('enable-dimension', {which})}
                        >
                          {definition.defined
                            ? 'Make it queryable'
                            : 'Create it as a dimension'}
                        </s-button>
                      )}
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>

        <Unavailable reason={promoted.unavailable} />

        {promotedRows.length > 0 && (
          <Fragment>
            <s-paragraph>
              {currency(promotedSales)} of {currency(totalSales)} came from
              products this campaign promoted, which is{' '}
              {promotedShare.toFixed(0)}% of what the store sold.
            </s-paragraph>
            {isClient && (
              <div className="chart-tooltip-fix" style={{height: '220px'}}>
                <PolarisVizProvider>
                  <BarChart
                    direction="horizontal"
                    data={[
                      {
                        name: 'Sales by campaign',
                        data: promotedRows.map((row) => ({
                          key: row.title,
                          value: row.sales,
                        })),
                      },
                    ]}
                    theme="Light"
                  />
                </PolarisVizProvider>
              </div>
            )}
          </Fragment>
        )}
      </s-section>
      {/* [END campaign-dashboard.metafield-dimension-render] */}

      <Unavailable
        heading={`What the ${tierLabel(campaign.audience).toLowerCase()} bought`}
        reason={tierSales.unavailable}
      />

      {/* [START campaign-dashboard.tier-render] */}
      {/* The tier came from the app and the sales came from the store, and the
          join happened in ShopifyQL rather than in the app. */}
      {tierRows.length > 0 && (
        <s-section heading={`What the ${tierLabel(campaign.audience).toLowerCase()} bought`}>
          <s-paragraph>
            {currency(tierTotal)} of {currency(totalSales)} came from the audience
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
        heading="The audience this campaign tagged"
        reason={roster.unavailable}
      />

      {/* [START campaign-dashboard.member-render] */}
      {/* The metafield says which tier someone is in and not which campaign put
          them there, so without the saved roster this list can't be rebuilt. */}
      {members.length > 0 && (
        <s-section heading="The audience this campaign tagged">
          <s-table>
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Spent in this window</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {members.map((member) => (
                <s-table-row key={member.id}>
                  <s-table-cell>{member.displayName}</s-table-cell>
                  <s-table-cell>{currency(member.spend)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
      {/* [END campaign-dashboard.member-render] */}
    </s-page>
  );
}

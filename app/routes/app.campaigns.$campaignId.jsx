import {Fragment, useEffect, useRef, useState} from 'react';
import {isRouteErrorResponse, useFetcher, useLoaderData, useRouteError} from 'react-router';
import {useAppBridge} from '@shopify/app-bridge-react';
import {boundary} from '@shopify/shopify-app-react-router/server';
import {authenticate} from '../shopify.server';
import {
  eventTotal,
  sendBlocker,
  sendCampaignFunnel,
  sendCount,
} from '../app-events.server';
import {
  deleteCampaign,
  findCampaign,
  lockCampaign,
  readCampaigns,
  transportErrors,
  updateCampaign,
  withReturnedErrors,
} from '../campaigns.server';
import {
  claimSend,
  forgetCampaign,
  recordSend,
  recordStampOperation,
  releaseSend,
} from '../campaign-state.server';
import {readStamping} from '../bulk-stamp.server';
import {queryShopifyQL} from '../shopifyql.server';
import {
  outcomeText,
  readSequence,
} from '../campaign-report.server';
import {
  SHOP_QUERY,
  TARGETS_DELETE,
  annotationsQuery,
  appEventsQuery,
  bounceQuery,
  codeSalesQuery,
  emptyTable,
  measureQuery,
  progressValue,
  promotedByQuery,
  qrFunnelQuery,
  qrSalesQuery,
  runIfSupported,
  runOptional,
  salesQuery,
  topProductsQuery,
  sequenceQuery,
  readTargets,
  targetNodes,
  tierSalesQuery,
  touchSalesQuery,
} from '../campaign-queries.server';
import {
  QR_MARK_PREFIX,
  campaignMarks,
  campaignWindow,
  codeFilter,
  isPositiveAmount,
  parseProducts,
  productId,
  promotedFilter,
  promotedNames,
  qrHandleFilter,
  qrHandles,
  safeLocale,
  inWindow,
  shopMorning,
  statusLabel,
} from '../campaigns';
import {CHANNELS} from '../channels';
import {getQRCode} from '../models/QRCode.server';
import {
  ChannelMetrics,
  Deliverability,
  SendEventsPanel,
  SendPerformance,
  bounceReasons as readBounceReasons,
  channelFunnels,
  funnelTotals,
  reachRowsFor,
  sendsByDay,
} from '../panels/app-events';
import {
  clearOwnMarks,
  closeCampaign,
  createAudienceTarget,
  createProductTarget,
  createQrTargets,
  createStoreTarget,
  endTargetsOn,
  flagIncident,
  isOwnTarget,
  isPlannedMark,
  markMilestone,
  raiseTarget,
  recordMark,
  recordedTarget,
  setAudience,
  setTargetAmounts,
  setProducts,
  stampOrders,
  stampProducts,
  stampTier,
  writeMarks,
} from '../campaign-mutations.server';
import {CampaignLifecycle, OrderStamping} from '../panels/close';
import {ConfirmButton} from '../panels/confirm';
import {
  SalesAndOrders,
  StoreTotals,
  TopProducts,
  annotationStatus,
  metricCardQuery,
  topProductsShape,
  useMetricCardsReady,
} from '../panels/sales';
import {
  CreatorRevenue,
  OrderAttribution,
  PromotedProductSales,
  QRCodeSales,
  SegmentSales,
  creatorShape,
  promotedShape,
  qrShape,
  tierShape,
  touchShape,
} from '../panels/dimensions';
import {IncidentBanner} from '../panels/incident';
import {TargetsPanel, splitTargets} from '../panels/targets';
import {measureTargets} from '../campaign-targets.server';
import {AUDIENCE_TIERS, isTargetedTier, tierLabel} from '../audiences';
import {analyticsReportHref} from '../annotations';
import {readDimensions} from '../dimensions.server';

export async function loader({request, params}) {
  // [START campaign-dashboard.campaign-load]
  // Redirect on a miss. A thrown response renders above this route's layout
  // and takes the app's navigation with it. The redirect keeps App Bridge's search params.
  const {admin: client, session, redirect} = await authenticate.admin(request);
  const admin = withReturnedErrors(client);
  const {appId, appName, campaigns, failed} = await readCampaigns(admin, session.shop);
  // Report a failed read. A redirect would treat the campaign as deleted.
  if (failed.length) {
    return {
      campaign: {title: 'Campaign'},
      fatal: failed.map((error) => error.message).join(' '),
      fatalHeading: "Couldn't load campaign",
    };
  }
  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) return redirect('/app/campaigns');
  // [END campaign-dashboard.campaign-load]

  // [START campaign-dashboard.locale]
  // The admin's locale rides in on the request. Formatting here matches the client.
  const locale = safeLocale(new URL(request.url).searchParams.get('locale'));
  // [END campaign-dashboard.locale]

  const dimensions = await readDimensions(admin, appId);
  const queryWindow = campaignWindow(campaign);

  const [
    salesBody,
    targetsBody,
    annotationsBody,
    funnel,
    sequenceTable,
    bounces,
    promoted,
    tierSales,
    touchSales,
    codeSales,
    qrSales,
    qrFunnel,
    topProducts,
  ] = await Promise.all([
    queryShopifyQL(admin, salesQuery(campaign)),
    readTargets(admin, campaign).catch(() => ({data: null})),
    runIfSupported(admin, annotationsQuery(campaign)),
    runOptional(admin, appEventsQuery(campaign, appName)),
    runOptional(admin, sequenceQuery(campaign, appName)),
    runOptional(admin, bounceQuery(campaign, appName)),
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
    // utm_campaign is built in. Each assigned code's handle is its value.
    qrHandleFilter(campaign)
      ? runOptional(admin, qrSalesQuery(campaign, qrHandleFilter(campaign)))
      : emptyTable(),
    qrHandleFilter(campaign)
      ? runOptional(admin, qrFunnelQuery(campaign, qrHandleFilter(campaign)))
      : emptyTable(),
    runOptional(admin, topProductsQuery(campaign)),
  ]);

  // [START campaign-dashboard.parse-errors]
  // Two failure paths. A missing scope nulls the field and lands in `errors`. A string
  // that doesn't parse resolves the field and reports on `parseErrors`.
  const sales = salesBody.data?.shopifyqlQuery;
  const fatal = !sales
    ? (salesBody.errors?.[0]?.message ??
      'The sales query returned no data. Check the read_reports scope and Level 2 protected customer data access.')
    : sales.parseErrors?.length
      ? sales.parseErrors.join(' ')
      : null;
  if (fatal) return {campaign, locale, fatal};
  // [END campaign-dashboard.parse-errors]

  const [targets, stamping] = await Promise.all([
    measureTargets(admin, campaign, targetsBody),
    readStamping(admin, campaign),
  ]);

  // Each image encodes the code's scan URL. Render it where the merchant
  // plans the campaign, ready to print.
  const qrCodes = (
    await Promise.all(
      campaign.qrCodes
        .filter((qrCode) => qrCode.handle)
        .map((qrCode) => getQRCode(qrCode.handle, admin.graphql, session.shop)),
    )
  ).filter(Boolean);

  const annotations = annotationsBody.data?.shop?.analyticsAnnotations?.nodes ?? [];

  return {
    campaign,
    locale,
    fatal: null,
    appId,
    eventTotal: eventTotal(campaign.channels),
    sendCount: sendCount(campaign.channels),
    // The sales schema has no currency column. Read it off the shop field.
    currencyCode: salesBody.data?.shop?.currencyCode ?? 'USD',
    // TIMESERIES buckets by the store's timezone. The browser's would misdate an annotation.
    timeZone: salesBody.data?.shop?.ianaTimezone ?? 'Etc/UTC',
    queryWindow,
    dimensions,
    rows: sales.tableData.rows,
    targets,
    annotations,
    funnel,
    sequence: readSequence(sequenceTable),
    bounces,
    promoted,
    tierSales,
    touchSales,
    codeSales,
    qrSales,
    qrFunnel,
    topProducts,
    qrCodes,
    stamping,
    sendBlocked: sendBlocker(campaign, salesBody.data?.shop?.ianaTimezone ?? 'Etc/UTC', locale),
  };
}


// [START campaign-dashboard.lifecycle]
// One action for every write. The lock holds off a second write to the campaign until
// this one ends.
export async function action({request, params}) {
  const {admin: client, session, redirect} = await authenticate.admin(request);
  const admin = withReturnedErrors(client);
  const lock = await lockCampaign(session.shop, params.campaignId);
  if (lock.problems) return {problems: lock.problems.map((error) => error.message)};
  try {
    return await runIntent(admin, session.shop, request, params, redirect);
  } finally {
    await lock.release();
  }
}

async function runIntent(admin, shop, request, params, redirect) {
  const form = await request.formData();
  const intent = String(form.get('intent'));

  const [{appId, appName, campaigns, failed}, shopBody] = await Promise.all([
    readCampaigns(admin, shop),
    admin.graphql(SHOP_QUERY).then((response) => response.json()),
  ]);
  // Redirecting on a failed read would report the campaign gone.
  if (failed.length) return {problems: failed.map((error) => error.message)};

  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) return redirect('/app/campaigns');

  const shopId = shopBody.data?.shop?.id ?? null;
  const timeZone = shopBody.data?.shop?.ianaTimezone ?? 'Etc/UTC';

  // This writes annotation text, and the sales schema has no currency column. Take the
  // currency off the shop. Formatting on an unknown code throws.
  const money = (value) =>
    new Intl.NumberFormat('en', {
      style: 'currency',
      currency: shopBody.data?.shop?.currencyCode ?? 'USD',
      maximumFractionDigits: 0,
    }).format(value);

  const markedAt = (date) =>
    new Date(shopMorning(date, timeZone)).toISOString();

  // `en-CA` formats as YYYY-MM-DD. Every date on a record is already in that shape.
  const shopToday = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  // A failed activation leaves the campaign planned with its targets saved, and a retry
  // reuses them as they were. Edits wait for a cancel, which deletes them.
  const savedTargets = Object.keys(campaign.targets ?? {}).length > 0;
  const savedTargetsProblem = {
    problems: ['This campaign already has targets from an activation. Cancel the campaign, then make the change.'],
  };

  if (intent === 'set-products' || intent === 'set-audience') {
    if (campaign.status !== 'planned') {
      return {problems: ['Only planned campaigns can change products or segment.']};
    }
    if (savedTargets) return savedTargetsProblem;
  }

  if (intent === 'set-products') {
    const products = parseProducts(form.get('products'));
    if (products === null) {
      return {problems: ["Couldn't read the selected products. Select them again."]};
    }
    const {userErrors} = await setProducts(admin, campaign, products);
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  // [START campaign-dashboard.audience-intent]
  if (intent === 'set-audience') {
    const audience = String(form.get('audience'));
    // The tier becomes a ShopifyQL comparison and a target filter, both built as
    // strings. Only a value this app defines can reach them.
    if (!AUDIENCE_TIERS.some((tier) => tier.value === audience)) {
      return {problems: ['Select a customer segment.']};
    }
    const {userErrors} = await setAudience(admin, campaign, audience);
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }
  // [END campaign-dashboard.audience-intent]

  if (intent === 'set-targets') {
    // Activation turns the amounts into targets. Later edits would drift from them.
    if (campaign.status !== 'planned') {
      return {problems: ['Targets can change only before the campaign is activated.']};
    }
    if (savedTargets) return savedTargetsProblem;
    const amounts = {};
    // The form omits targets this campaign can't activate. An absent amount keeps its
    // saved value, and a blank one clears the target.
    for (const key of ['revenueTarget', 'productTarget', 'audienceTarget', 'qrTarget']) {
      if (!form.has(key)) continue;
      const value = String(form.get(key)).trim();
      if (value && !(/^\d+(\.\d{1,2})?$/.test(value) && isPositiveAmount(value))) {
        return {
          problems: ['Enter a target above zero, or leave it blank.'],
        };
      }
      amounts[key] = value;
    }
    const {userErrors} = await setTargetAmounts(admin, campaign, amounts);
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  // [START campaign-dashboard.send-events-action]
  if (intent === 'send-events') {
    // A planned campaign would date its sends in the future.
    if (campaign.status !== 'running') {
      return {problems: ['Only active campaigns can send events.']};
    }
    const blocked = sendBlocker(
      campaign,
      timeZone,
      safeLocale(new URL(request.url).searchParams.get('locale')),
    );
    if (blocked) return {problems: [blocked]};
    if (!shopId) return {problems: ["Couldn't read the store ID. Reload and try again."]};
    // The App Events API can't retract an event, and a second replay doubles every funnel
    // denominator. The claim gates it, because the funnel read lags ingestion by minutes.
    const claimed = await claimSend(shop, campaign.id, campaign.gid).catch((error) => {
      console.error('Could not claim the send', error);
      return null;
    });
    if (claimed === null) return {problems: ["Couldn't check for an earlier send. Try again."]};
    if (!claimed) {
      return {
        problems: [
          'Events already sent. Create a new campaign to send them again.',
        ],
      };
    }
    const {accepted, failures} = await sendCampaignFunnel({
      shopId,
      campaignId: campaign.id,
      startDate: campaign.startDate,
      timeZone,
      channels: campaign.channels,
    });
    const sent = Object.values(accepted).reduce((total, n) => total + n, 0);
    // Record what landed before reporting failures. Idempotency keys expire after 24 hours,
    // and an unrecorded partial send would let a later run duplicate it.
    const landed = sent
      ? [
          `Shopify received ${sent} of ${eventTotal(campaign.channels)} events. The funnel reports the events that pass validation, and a second send would count them twice.`,
        ]
      : [];
    if (sent > 0) {
      // A failed record keeps the claim, and a second send stays blocked.
      const recorded = await recordSend(shop, campaign.id, sent).then(
        () => true,
        (error) => {
          console.error('Could not record the send', error);
          return false;
        },
      );
      if (!recorded) {
        return {
          heading: "Events sent, but the campaign didn't record them",
          problems: [...landed, ...failures, "Couldn't save the campaign's records."],
        };
      }
    } else {
      // Nothing landed. Releasing the claim lets the merchant send again.
      await releaseSend(shop, campaign.id).catch((error) =>
        console.error('Could not release the send', error),
      );
    }
    if (failures.length > 0) {
      return {heading: sent ? "Some events didn't send" : undefined, problems: [...landed, ...failures]};
    }
    return {ok: true};
  }
  // [END campaign-dashboard.send-events-action]

  // Read by the activate and close branches below.
  const dimensions = await readDimensions(admin, appId);

  if (intent === 'activate') {
    // Gate on the record's status. A target the user set on the same date isn't
    // evidence that this campaign is active.
    if (campaign.status !== 'planned') {
      return {
        problems: [
          `This campaign is ${statusLabel(campaign.status).toLowerCase()}. Only a planned campaign can be activated.`,
        ],
      };
    }

    const {markers, problems: unmarked} = await writeMarks(
      admin,
      campaign,
      appId,
      markedAt,
    );
    if (unmarked.length) return {problems: unmarked};

    // A failed activation left its target IDs on the record. Create only the missing
    // targets, or the retry makes a second set the app can never reach.
    const targets = {...(campaign.targets ?? {})};
    const rejected = [];
    const missing = [
      ['store', () => createStoreTarget(admin, campaign)],
      ['product', () => createProductTarget(admin, campaign)],
      ['audience', () => createAudienceTarget(admin, campaign, dimensions.customer)],
    ].filter(([key]) => !targets[key]);
    const results = await Promise.all(missing.map(([, create]) => create()));
    const created = {};
    missing.forEach(([key], index) => {
      if (results[index].id) created[key] = results[index].id;
      rejected.push(...results[index].userErrors);
    });
    const qr = await createQrTargets(admin, {
      ...campaign,
      qrCodes: campaign.qrCodes.filter(
        (qrCode) => !targets[`${QR_MARK_PREFIX}${qrCode.handle}`],
      ),
    });
    Object.assign(created, qr.targets);
    rejected.push(...qr.userErrors);

    // Save the IDs before the stamps run, and delete what was created if that
    // write fails.
    if (Object.keys(created).length) {
      Object.assign(targets, created);
      const {userErrors: unsaved} = await updateCampaign(admin, campaign, {
        targets,
      });
      if (unsaved.length) {
        const rollback = await (
          await admin.graphql(TARGETS_DELETE, {
            variables: {ids: Object.values(created)},
          })
        ).json();
        return {
          problems: [
            ...unsaved,
            ...transportErrors(rollback),
            ...(rollback.data?.analyticsTargetsDelete?.userErrors ?? []),
          ].map((error) => error.message),
        };
      }
    }

    const unstamped = await stampProducts(admin, campaign);
    const {userErrors: untiered} = await stampTier(admin, campaign, dimensions.customer);
    const {userErrors} = await updateCampaign(admin, campaign, {
      status: 'running',
      markers,
      targets,
    });
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }

    // A rejected target or stamp is a warning beside an activation that went through.
    const problems = [...rejected, ...unstamped, ...untiered].map(
      (error) => error.message,
    );
    return problems.length ? {ok: true, problems} : {ok: true};
  }

  // [START campaign-dashboard.rewrite-marks]
  // Replace what's on the store. Read the annotations this app wrote, delete them, and put
  // the current marks up in their place.
  if (intent === 'rewrite-marks') {
    // Closing moved the span's `endedAt` off null and put the outcome in the title.
    // Rewriting reopens that span. Offered while the campaign runs.
    if (campaign.status !== 'running') {
      return {problems: ['Only active campaigns can rewrite annotations.']};
    }
    const {markers, problems} = await writeMarks(
      admin,
      campaign,
      appId,
      markedAt,
    );
    if (problems.length) return {problems};

    const {userErrors} = await updateCampaign(admin, campaign, {markers});
    return userErrors.length
      ? {problems: userErrors.map((error) => error.message)}
      : {ok: true, rewrote: Object.keys(markers).filter(isPlannedMark).length};
  }
  // [END campaign-dashboard.rewrite-marks]

  if (intent === 'raise-target') {
    // Targets exist from activation to close. Raising one after the outcome measured it
    // would leave the recorded result and the target disagreeing.
    if (campaign.status !== 'running') {
      return {problems: ['Only active campaigns can raise targets.']};
    }
    const targetsBody = await readTargets(admin, campaign);
    const target = recordedTarget(campaign, targetsBody, form.get('targetId'));
    if (!target?.shopifyqlQuery) return {problems: ["Couldn't measure this target."]};

    const measured = await queryShopifyQL(admin, measureQuery(target.shopifyqlQuery));
    const actual = progressValue(measured.data?.shopifyqlQuery);
    // A raise is permanent. An unmeasured target would move the goal to the floor.
    if (actual === null) {
      return {problems: ["Couldn't measure this target. Reload and try again."]};
    }
    if (actual < Number(target.expectedValue)) {
      return {problems: ['This target isn\'t reached yet.']};
    }
    const userErrors = await raiseTarget(admin, {...target, actual});
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'milestone') {
    if (campaign.status !== 'running') {
      return {problems: ['Only active campaigns can mark milestones.']};
    }
    const day = String(form.get('day'));
    if (!inWindow(campaign, day)) {
      return {problems: ['Pick a day inside the campaign.']};
    }
    const targetsBody = await readTargets(admin, campaign);
    const target = recordedTarget(campaign, targetsBody, form.get('targetId'));
    if (!target) return {problems: ['That target no longer exists.']};

    // One mark per target per day. A second write would leave the first annotation
    // on the timeline with nothing pointing at it.
    const key = `milestone:${productId(target.id)}:${day}`;
    if (campaign.markers?.[key]) {
      return {problems: ['This target already has a milestone for this day.']};
    }

    const result = await markMilestone(admin, target, markedAt(day), money);
    if (result.userErrors?.length) {
      return {problems: result.userErrors.map((error) => error.message)};
    }
    // The saved ID is the handle a rewrite or a cancel needs. An unchecked write
    // leaves the annotation on the timeline with nothing pointing at it.
    const saved = await recordMark(
      admin,
      campaign,
      key,
      result.analyticsAnnotation?.id,
    );
    if (saved?.userErrors?.length) {
      return {problems: saved.userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  // [START campaign-dashboard.flag-incident-action]
  if (intent === 'flag-incident') {
    if (campaign.status !== 'running') {
      return {problems: ['Only active campaigns can flag incidents.']};
    }
    const day = String(form.get('day'));
    if (!inWindow(campaign, day)) {
      return {problems: ['Pick a day inside the campaign.']};
    }
    if (campaign.markers?.[`incident:${day}`]) {
      return {problems: ['An incident is already flagged for this day.']};
    }

    const result = await flagIncident(admin, campaign, appName, markedAt(day));
    if (result.userErrors?.length) {
      return {problems: result.userErrors.map((error) => error.message)};
    }
    const saved = await recordMark(
      admin,
      campaign,
      `incident:${day}`,
      result.analyticsAnnotation?.id,
    );
    if (saved?.userErrors?.length) {
      return {problems: saved.userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }
  // [END campaign-dashboard.flag-incident-action]

  if (intent === 'close') {
    // The outcome annotation is a closed campaign's permanent record. The status write
    // lands last, and a failed attempt stays retryable.
    if (campaign.status !== 'running') {
      return {problems: ['You can close only active campaigns.']};
    }
    if (shopToday < campaign.startDate) {
      return {problems: ["This campaign hasn't started. Cancel it instead."]};
    }
    // A campaign can close before its window runs out. Everything below reads the
    // window that ran.
    const closedOn =
      shopToday < campaign.endDate ? shopToday : campaign.endDate;
    const closing = {...campaign, endDate: closedOn};

    // Shorten the targets first, or they keep measuring days the campaign didn't run.
    // A target that can't move keeps its end date, and the close reports it.
    const {problems: stillOpen, warnings: kept} =
      closedOn < campaign.endDate
        ? await endTargetsOn(admin, campaign, closedOn)
        : {problems: [], warnings: []};
    if (stillOpen.length) {
      return {problems: stillOpen.map((error) => error.message)};
    }

    const [sequenceTable, targetsBody] = await Promise.all([
      runOptional(admin, sequenceQuery(closing, appName)),
      readTargets(admin, closing),
    ]);

    // A failed read returns no nodes, the same shape as a deleted target. Closing
    // is permanent. Only the deleted case is allowed through.
    if (targetsBody.errors?.length) {
      return {problems: ["Couldn't read targets. Reload and close the campaign again."]};
    }

    // The ID activation recorded. A target the user made on the same date
    // measures the same days without being this campaign's.
    const store = targetNodes(targetsBody).find(
      (node) => node.id === campaign.targets?.store,
    );
    // Targets are optional. Without one, measure the window's sales directly.
    const measured = await queryShopifyQL(
      admin,
      measureQuery(
        store?.shopifyqlQuery ??
          `FROM sales SHOW total_sales SINCE ${closing.startDate} UNTIL ${closedOn}`,
      ),
    );
    const revenue = progressValue(measured.data?.shopifyqlQuery);
    // Closing is permanent, and a failed read would record the campaign at zero.
    if (revenue === null) {
      return {problems: ["Couldn't measure sales. Reload and close the campaign again."]};
    }

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

    // An early close leaves the planned marks for days that never ran. A recorded mark
    // the campaign's fields no longer produce never runs either.
    const ran = new Set(
      campaignMarks(campaign)
        .filter((mark) => mark.date <= closedOn)
        .map((mark) => mark.key),
    );
    const unrun = Object.keys(campaign.markers ?? {}).filter(
      (key) => isPlannedMark(key) && !ran.has(key),
    );
    const markers = {...campaign.markers};
    if (unrun.length) {
      const left = await clearOwnMarks(
        admin,
        unrun.map((key) => markers[key]),
        appId,
      );
      if (left.length) return {problems: left.map((error) => error.message)};
      for (const key of unrun) delete markers[key];
    }

    // Attribution needs the orders to exist, and close is the first point they do.
    // Skipped until the definition is a dimension.
    if (dimensions.order.enabled) {
      const started = await startStamping(admin, shop, closing);
      if (started.problems) return started;
    }

    const {userErrors} = await updateCampaign(admin, campaign, {
      status: 'closed',
      endDate: closedOn,
      ...(unrun.length ? {markers} : {}),
    });
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return kept.length
      ? {ok: true, problems: kept.map((error) => error.message)}
      : {ok: true};
  }

  // [START campaign-dashboard.stamp-orders-retry]
  // A failed bulk operation leaves orders unstamped. Stamping again writes the same values.
  if (intent === 'stamp-orders') {
    if (campaign.status !== 'closed' || !dimensions.order.enabled) {
      return {problems: ['Only closed campaigns with order attribution can stamp orders.']};
    }
    const current = await readStamping(admin, campaign);
    if (current?.state === 'running') {
      return {problems: ['Orders are still being stamped. Wait for that to finish.']};
    }
    return startStamping(admin, shop, campaign);
  }
  // [END campaign-dashboard.stamp-orders-retry]

  if (intent === 'cancel') {
    // A closed campaign keeps its outcome on the store's charts. A cancel only takes
    // down a planned or running one.
    if (campaign.status !== 'planned' && campaign.status !== 'running') {
      return {problems: ['You can cancel only planned or active campaigns.']};
    }
    // The merchant can edit the record, and `analyticsTargetsDelete` deletes any target.
    // Delete only annotations this app created and targets ending in this app's names.
    const undone = await clearOwnMarks(
      admin,
      Object.values(campaign.markers ?? {}),
      appId,
    );
    const kept = undone.map((error) => error.id);
    const markers = Object.fromEntries(
      Object.entries(campaign.markers ?? {}).filter(
        ([, id]) => kept.includes(null) || kept.includes(id),
      ),
    );

    const targets = {...campaign.targets};
    const read = await readTargets(admin, campaign);
    const unread = transportErrors(read);
    undone.push(...unread);
    const ours = unread.length ? [] : targetNodes(read).filter(isOwnTarget);
    if (ours.length > 0) {
      const body = await (
        await admin.graphql(TARGETS_DELETE, {variables: {ids: ours.map((target) => target.id)}})
      ).json();
      const result = body.data?.analyticsTargetsDelete;
      const deletedIds = result?.deletedIds ?? [];
      const failed = [...transportErrors(body), ...(result?.userErrors ?? [])];
      if (!failed.length && ours.some((target) => !deletedIds.includes(target.id))) {
        failed.push({message: "Couldn't delete every target. Cancel the campaign again."});
      }
      undone.push(...failed);
      for (const deleted of deletedIds) {
        const key = Object.keys(targets).find((name) => targets[name] === deleted);
        if (key) delete targets[key];
      }
    }
    // Clearing the record on a failed delete abandons what's still on the timeline. The
    // IDs are the only handle the app has on it.
    if (undone.length) {
      const {userErrors} = await updateCampaign(admin, campaign, {
        markers,
        targets,
      });
      return {problems: [...undone, ...userErrors].map((error) => error.message)};
    }

    // Canceling undoes the annotations and the targets, and nothing else.
    const {userErrors} = await updateCampaign(admin, campaign, {
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
    // Activating records new target IDs over the old ones. Replanning a live campaign
    // would leave its targets on the store with nothing pointing at them.
    if (campaign.status !== 'canceled') {
      return {problems: ['You can replan only canceled campaigns.']};
    }
    // Canceling removed the annotations and targets. The promoted products keep their
    // `campaign` metafield, and the next activation writes it again.
    const {userErrors} = await updateCampaign(admin, campaign, {status: 'planned'});
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'delete') {
    // Canceling removed the annotations and targets. Deleting any other status would
    // abandon them on the charts. The promoted products keep their `campaign` metafield.
    if (campaign.status !== 'canceled') {
      return {problems: ['Only a canceled campaign can be deleted.']};
    }
    const {userErrors} = await deleteCampaign(admin, campaign);
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    // The entry is gone, and its ID stays spent. A failed delete leaves an unused row.
    await forgetCampaign(shop, campaign.id).catch((error) =>
      console.error('Could not delete campaign state', error),
    );
    return redirect('/app/campaigns');
  }

  return {problems: ['Unknown action.']};
}
// [END campaign-dashboard.lifecycle]

// [START campaign-dashboard.start-stamping]
// The page polls the recorded operation. An unrecorded one still runs, but nothing reports it.
async function startStamping(admin, shop, campaign) {
  const {operationId, userErrors} = await stampOrders(admin, campaign);
  if (userErrors.length) return {problems: userErrors.map((error) => error.message)};
  if (!operationId) return {ok: true};
  const recorded = await recordStampOperation(shop, campaign.id, campaign.gid, operationId)
    .then(() => true)
    .catch((error) => {
      console.error('Could not record the stamp operation', error);
      return false;
    });
  return recorded
    ? {ok: true}
    : {problems: ["Started stamping orders, but couldn't save the operation to track it."]};
}
// [END campaign-dashboard.start-stamping]

// [START campaign-dashboard.unavailable-note]
// A query that never ran looks like a store that sold nothing. Only the failure is actionable.
function Unavailable({reason, heading}) {
  if (!reason) return null;
  const note = (
    <s-banner tone="info" heading="This report didn't load">
      <s-paragraph>Reload the page to try again. The store returned: {reason}</s-paragraph>
    </s-banner>
  );
  return heading ? <s-section heading={heading}>{note}</s-section> : note;
}
// [END campaign-dashboard.unavailable-note]


const DONE = {
  activate: 'Campaign activated',
  close: 'Campaign closed',
  cancel: 'Campaign canceled',
  replan: 'Campaign replanned',
  'set-products': 'Products saved',
  'set-audience': 'Customer segment saved',
  'set-targets': 'Targets saved',
  'send-events': 'Events sent. Reload in a few minutes.',
  'raise-target': 'Target raised',
  milestone: 'Milestone marked',
  'flag-incident': 'Incident flagged',
  'stamp-orders': 'Order stamping started',
};

// [START campaign-dashboard.totals]
// WITH TOTALS and PERCENT_CHANGE name their columns after the metric and the period.
// A percent is null when the period it compares against sold nothing.
export function salesTotals(rows) {
  const totals = rows[0] ?? {};
  const change = (percent, before) =>
    percent == null || Number(before ?? 0) === 0 ? null : Number(percent);
  return {
    totalSales: totals['total_sales__totals'] ?? '0',
    percentChange: change(
      totals['percent_change_total_sales__previous_period__totals'],
      totals['comparison_total_sales__previous_period__totals'],
    ),
    yearChange: change(
      totals['percent_change_total_sales__previous_year__totals'],
      totals['comparison_total_sales__previous_year__totals'],
    ),
    newCustomers: Number(totals['new_customers__totals'] ?? 0),
    firstTimeSales: totals['total_sales_first_time__totals'] ?? '0',
  };
}
// [END campaign-dashboard.totals]

export default function CampaignDashboard() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const cardReady = useMetricCardsReady();

  const [range, setRange] = useState('last30days');

  // Hooks run before the early return below. React needs the same hooks on every render.
  const problems = fetcher.data?.problems ?? [];
  // Problems alongside `ok` mean the action landed with something rejected inside it.
  const partial = Boolean(fetcher.data?.ok);
  // An action that landed part of its work names that in the heading.
  const landedHeading = fetcher.data?.heading;
  // Only the in-flight intent's button spins.
  const busy = fetcher.state === 'idle' ? null : (fetcher.formData?.get('intent') ?? 'pending');
  const pending = useRef(null);
  useEffect(() => {
    if (busy) pending.current = busy;
  }, [busy]);
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data?.ok || fetcher.data.problems?.length) return;
    const message = DONE[pending.current];
    if (message) shopify.toast.show(message);
  }, [fetcher.state, fetcher.data, shopify]);
  // The select keeps the value picked in it. A rejected save puts the saved one back.
  const audienceSelect = useRef(null);
  const savedAudience = data.campaign?.audience;
  useEffect(() => {
    if (fetcher.state !== 'idle' || pending.current !== 'set-audience') return;
    if (fetcher.data?.problems?.length && audienceSelect.current) {
      audienceSelect.current.value = savedAudience;
    }
  }, [fetcher.state, fetcher.data, savedAudience]);

  const {campaign, locale, fatal, fatalHeading} = data;

  if (fatal) {
    return (
      <s-page heading={campaign.title}>
        <s-section>
          <s-banner tone="critical" heading={fatalHeading ?? "Couldn't load sales"}>
            <s-paragraph>{fatal}</s-paragraph>
          </s-banner>
          <s-box paddingBlockStart="base">
            <s-link href="/app/campaigns">Back to campaigns</s-link>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  const {
    appId,
    eventTotal,
    sendCount,
    currencyCode,
    timeZone,
    queryWindow,
    dimensions,
    rows,
    targets,
    annotations,
    funnel,
    sequence,
    bounces,
    sendBlocked,
    promoted,
    tierSales,
    touchSales,
    codeSales,
    qrSales,
    qrFunnel,
    topProducts,
    qrCodes,
    stamping,
  } = data;

  // [START campaign-dashboard.read]
  // Generated column names are the contract.
  const cell = (row, name) => row[name];
  // [END campaign-dashboard.read]

  // [START campaign-dashboard.format]
  // Money comes back as a string for precision. Format it here.
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

  // Written as 9am in the store's timezone. Slicing the UTC string is a day early.
  const shopDay = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayOf = (instant) => shopDay.format(new Date(instant));
  // [END campaign-dashboard.format]

  const {totalSales, percentChange, yearChange, newCustomers, firstTimeSales} =
    salesTotals(rows);

  const {productRows, otherSales} = topProductsShape({topProducts, cell});

  const {storeTarget, scopedTargets} = splitTargets(targets);

  const {marks, ours, outdated, openCampaign, incidentFlagged} = annotationStatus({
    campaign,
    annotations,
    appId,
  });

  // The same conditions activation applies. A blank amount is no target.
  const plannedTargetCount =
    (isPositiveAmount(campaign.revenueTarget) ? 1 : 0) +
    (promotedFilter(campaign) && isPositiveAmount(campaign.productTarget) ? 1 : 0) +
    (isTargetedTier(campaign.audience) &&
    dimensions.customer.enabled &&
    isPositiveAmount(campaign.audienceTarget)
      ? 1
      : 0) +
    (isPositiveAmount(campaign.qrTarget) ? qrHandles(campaign).length : 0);

  const cardQuery = metricCardQuery(range);

  const {total, rate, sent, bounced, unsubscribed, health} = funnelTotals(funnel, cell);

  const reachRows = reachRowsFor(campaign, total);

  const funnels = channelFunnels(campaign, total);

  const sends = sendsByDay(funnel, cell);

  const bounceReasons = readBounceReasons({bounces, cell, humanize});

  const exploreHref = analyticsReportHref({
    window: queryWindow,
    annotations: ours,
  });

  const {promotedRows, promotedSales, promotedShare} = promotedShape({
    promoted,
    campaign,
    totalSales,
    cell,
    rate,
  });

  const {tierRows, tierTotal, tierShare} = tierShape({
    tierSales,
    totalSales,
    cell,
    rate,
  });

  const touchRows = touchShape({touchSales, campaign, cell});

  const {creatorRows, codeTotal, touchedTotal} = creatorShape({
    codeSales,
    campaign,
    touchRows,
    cell,
  });

  const {qrRows, qrTotal, qrShare} = qrShape({
    qrSales,
    qrFunnel,
    campaign,
    totalSales,
    cell,
    rate,
  });

  const today = dayOf(Date.now());
  // Closing early ends it today. The action clamps the same.
  const closesOn = today < campaign.endDate ? today : campaign.endDate;

  const submit = (intent, fields = {}) =>
    fetcher.submit(
      {
        intent,
        ...fields,
      },
      {method: 'post'},
    );

  function saveTargets(event) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    values.set('intent', 'set-targets');
    fetcher.submit(values, {method: 'post'});
  }

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
  // These panels report on annotations and targets a cancel already deleted.
  const canceled = campaign.status === 'canceled';

  // Beside the store's totals on an active campaign, and on its own before one.
  const statusLine = (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-badge
        tone={
          {
            planned: 'info',
            running: 'success',
            closed: 'neutral',
            canceled: 'neutral',
          }[campaign.status]
        }
      >
        {statusLabel(campaign.status)}
      </s-badge>
      <s-text color="subdued">
        {shortDate(campaign.startDate)} to {shortDate(campaign.endDate)}
      </s-text>
      <s-text color="subdued">
        {campaign.channels.map((key) => CHANNELS[key].label).join(', ')}
      </s-text>
    </s-stack>
  );

  // A percentage says nothing about whether the rest is reachable. This divides the
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
            running && today <= campaign.endDate ? dayGap(today, campaign.endDate) + 1 : 0;
          const earned = Number(storeTarget.actual ?? 0);
          const short = Math.max(0, Number(storeTarget.expectedValue) - earned);
          return {perDay: earned / elapsed, needed: left > 0 ? short / left : short, left};
        })()
      : null;

  const markNote =
    !planned && ours.length === 0
      ? 'No annotations for this campaign.'
      : outdated > 0
        ? `${outdated} ${outdated === 1 ? 'annotation is' : 'annotations are'} outdated. ` +
          `Rewriting replaces ${outdated === 1 ? 'it' : 'them'} with the current ${marks.length}.`
        : null;

  return (
    <s-page heading={campaign.title}>
      {problems.length > 0 && (
        <s-section>
          <s-banner
            tone={partial || landedHeading ? 'warning' : 'critical'}
            heading={
              landedHeading
                ? landedHeading
                : partial
                  ? 'Completed with warnings'
                  : 'Action failed'
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
      {/* Before activation there are no totals to sit beside. Activate and Cancel
          are the only actions, and they share the top of the page. */}
      {planned && (
        <s-section>
          <s-stack direction="block" gap="base">
            {statusLine}
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                loading={busy === 'activate'}
                disabled={Boolean(busy)}
                onClick={() => submit('activate')}
              >
                Activate campaign
              </s-button>
              <ConfirmButton
                id="cancel-planned"
                tone="critical"
                label="Cancel campaign"
                heading="Cancel this campaign?"
                body="The campaign stops before it starts. You can replan it or delete it afterward."
                confirmLabel="Cancel campaign"
                loading={busy === 'cancel'}
                disabled={Boolean(busy)}
                onConfirm={() => submit('cancel')}
              />
            </s-stack>
          </s-stack>
        </s-section>
      )}
      {/* [END campaign-dashboard.status-render] */}

      {planned && (
        <Fragment>
          {/* Everything activation writes, listed before it writes it. */}
          <s-section heading="Campaign setup">
            <s-box paddingBlockStart="base" />
            <s-paragraph>Activation creates:</s-paragraph>
            <s-unordered-list>
              <s-list-item>
                {marks.length} {marks.length === 1 ? 'annotation' : 'annotations'}.
                One covers the full campaign dates.
              </s-list-item>
              <s-list-item>
                {plannedTargetCount} analytics{' '}
                {plannedTargetCount === 1 ? 'target' : 'targets'} through{' '}
                {shortDate(campaign.endDate)}.
              </s-list-item>
              <s-list-item>
                A campaign metafield on{' '}
                {campaign.products.length === 0
                  ? 'the products you select'
                  : `${campaign.products.length} ${
                      campaign.products.length === 1 ? 'product' : 'products'
                    }`}
                {isTargetedTier(campaign.audience)
                  ? ` and a segment metafield on each ${tierLabel(campaign.audience)} customer.`
                  : '. The Everyone segment needs no customer metafields.'}
              </s-list-item>
            </s-unordered-list>

            <s-box paddingBlockStart="base" />

            <s-stack direction="block" gap="small-200">
              <s-text>
                Promoted products:{' '}
                {promotedNames(campaign) || 'None selected'}
              </s-text>
              <s-stack direction="inline" gap="base">
                <s-button
                  loading={busy === 'set-products'}
                  disabled={Boolean(busy)}
                  onClick={changeProducts}
                >
                  {campaign.products.length > 0
                    ? 'Change products'
                    : 'Select products'}
                </s-button>
              </s-stack>
              <s-select
                ref={audienceSelect}
                label="Customer segment"
                value={campaign.audience}
                disabled={Boolean(busy)}
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
          </s-section>

          {/* [START campaign-dashboard.qr-setup-render] */}
          <s-section heading="QR codes">
            <s-box paddingBlockStart="base" />
            {(qrCodes ?? []).length > 0 ? (
              <s-stack direction="block" gap="base">
                <s-text>
                  Print the code or scan it from the screen. Each scan opens
                  the storefront with the code's UTM parameters. QR code sales
                  reports orders placed after a scan.
                </s-text>
                {qrCodes.map((code) => (
                  <s-stack key={code.handle} direction="block" gap="small-200">
                    {code.productTitle && (
                      <s-text>
                        {code.destination === 'cart'
                          ? `Opens checkout with ${code.productTitle} in the cart.`
                          : `Opens the ${code.productTitle} product page.`}
                      </s-text>
                    )}
                    <s-stack
                      direction="block"
                      gap="small-200"
                      inlineSize="200px"
                    >
                      <s-image
                        aspectRatio="1/1"
                        src={code.image}
                        alt={`${code.title} QR code`}
                      />
                      <s-link href={`/app/qrcodes/${code.handle}`}>
                        Edit QR code
                      </s-link>
                    </s-stack>
                  </s-stack>
                ))}
              </s-stack>
            ) : (
              <s-text>
                No QR codes. QR code sales reports orders placed after a scan.
              </s-text>
            )}
            {/* Codes join a campaign before activation. */}
            {campaign.status === 'planned' && (
              <>
                <s-box paddingBlockStart="base" />
                <s-link
                  href={`/app/qrcodes/new?campaign=${encodeURIComponent(campaign.gid)}`}
                >
                  Create a QR code for this campaign
                </s-link>
              </>
            )}
          </s-section>
          {/* [END campaign-dashboard.qr-setup-render] */}

          {/* Each amount becomes a target at activation. A blank one is no target. */}
          <form onSubmit={saveTargets}>
            <s-section heading="Targets">
              <s-box paddingBlockStart="base" />
              <s-stack direction="block" gap="base">
                <s-money-field
                  label="Store sales target"
                  name="revenueTarget"
                  value={campaign.revenueTarget}
                  min={0}
                  details="Measures total sales. Leave blank for no target."
                />
                {/* A disabled field doesn't submit, and the action keeps its saved amount. */}
                <s-money-field
                  label="Promoted product target"
                  name="productTarget"
                  value={campaign.productTarget}
                  min={0}
                  disabled={campaign.products.length === 0}
                  details={
                    promotedNames(campaign) ||
                    'Select promoted products under Campaign setup to set this target.'
                  }
                />
                {isTargetedTier(campaign.audience) && (
                  <s-money-field
                    label="Customer segment target"
                    name="audienceTarget"
                    value={campaign.audienceTarget}
                    min={0}
                    disabled={!dimensions.customer.enabled}
                    details={
                      dimensions.customer.enabled
                        ? `Sales to the ${tierLabel(campaign.audience)} segment`
                        : 'Make the customer dimension queryable on the campaign list to set this target.'
                    }
                  />
                )}
                <s-money-field
                  label="QR code target"
                  name="qrTarget"
                  value={campaign.qrTarget}
                  min={0}
                  disabled={campaign.qrCodes.length === 0}
                  details={
                    campaign.qrCodes.length
                      ? 'Creates one target for each assigned QR code. Each target measures attributed sales.'
                      : 'Assign a QR code to this campaign to set this target.'
                  }
                />
                <s-button
                  variant="primary"
                  type="submit"
                  loading={busy === 'set-targets'}
                  disabled={Boolean(busy)}
                >
                  Save targets
                </s-button>
              </s-stack>
            </s-section>
          </form>
        </Fragment>
      )}

      {/* A planned or canceled campaign has nothing attributed to it. Reporting the
          store's sales for its window would read as a result the campaign produced. */}
      {!planned && !canceled && (
        <Fragment>
        <TargetsPanel
          targets={targets}
          storeTarget={storeTarget}
          scopedTargets={scopedTargets}
          campaign={campaign}
          dimensions={dimensions}
          pace={pace}
          running={running}
          busy={busy}
          submit={submit}
          today={today}
          currency={currency}
          shortDate={shortDate}
        />

        <StoreTotals
          statusLine={statusLine}
          cardReady={cardReady}
          range={range}
          setRange={setRange}
          cardQuery={cardQuery}
        />

        <SalesAndOrders
          campaign={campaign}
          totalSales={totalSales}
          percentChange={percentChange}
          yearChange={yearChange}
          newCustomers={newCustomers}
          firstTimeSales={firstTimeSales}
          rows={rows}
          cell={cell}
          shortDate={shortDate}
          sends={sends}
          marks={marks}
          ours={ours}
          running={running}
          markNote={markNote}
          rewrote={fetcher.data?.rewrote}
          exploreHref={exploreHref}
          busy={busy}
          submit={submit}
          currency={currency}
          percent={percent}
        />


        <SendEventsPanel
          running={running}
          funnel={funnel}
          sendCount={sendCount}
          eventTotal={eventTotal}
          alreadySent={campaign.sentEvents != null}
          blocked={sendBlocked}
          busy={busy}
          submit={submit}
        />

        <ChannelMetrics funnels={funnels} integer={integer} />

        <IncidentBanner
          health={health}
          bounced={bounced}
          bounceReasons={bounceReasons}
          incidentFlagged={incidentFlagged}
          total={total}
          integer={integer}
          busy={busy}
          submit={submit}
          today={today}
          canFlag={running && inWindow(campaign, today)}
        />

        <SendPerformance sequence={sequence} integer={integer} />

        <Deliverability
          sent={sent}
          health={health}
          reachRows={reachRows}
          unsubscribed={unsubscribed}
          rate={rate}
          integer={integer}
        />

        <Unavailable heading="Top products" reason={topProducts.unavailable} />

        <TopProducts
          productRows={productRows}
          otherSales={otherSales}
          currency={currency}
        />

        <Unavailable
          heading="Promoted product sales"
          reason={promoted.unavailable}
        />

        <PromotedProductSales
          promotedRows={promotedRows}
          promotedSales={promotedSales}
          promotedShare={promotedShare}
          totalSales={totalSales}
          dimensions={dimensions}
          currency={currency}
          shortDate={shortDate}
        />

        <Unavailable
          heading={`${tierLabel(campaign.audience)} segment sales`}
          reason={tierSales.unavailable}
        />

        <SegmentSales
          campaign={campaign}
          tierRows={tierRows}
          tierTotal={tierTotal}
          tierShare={tierShare}
          totalSales={totalSales}
          currency={currency}
          shortDate={shortDate}
        />

        <Unavailable
          heading="Order attribution"
          reason={touchSales.unavailable}
        />

        <OrderAttribution
          touchRows={touchRows}
          dimensions={dimensions}
          currency={currency}
        />

        <Unavailable heading="Creator revenue" reason={codeSales.unavailable} />

        <CreatorRevenue
          creatorRows={creatorRows}
          codeTotal={codeTotal}
          touchedTotal={touchedTotal}
          currency={currency}
        />

        <Unavailable heading="QR code sales" reason={qrSales.unavailable} />

        <Unavailable heading="QR code sessions" reason={qrFunnel.unavailable} />

        <QRCodeSales
          campaign={campaign}
          cardReady={cardReady}
          qrRows={qrRows}
          qrTotal={qrTotal}
          qrShare={qrShare}
          totalSales={totalSales}
          currency={currency}
        />

        </Fragment>
      )}

      <OrderStamping stamping={stamping} busy={busy} submit={submit} />

      <CampaignLifecycle
        campaign={campaign}
        openCampaign={openCampaign}
        closesOn={closesOn}
        running={running}
        busy={busy}
        submit={submit}
        shortDate={shortDate}
        stampsOrders={dimensions.order.enabled}
      >
        {campaign.status === 'canceled' && (
          <ConfirmButton
            id="delete-campaign"
            tone="critical"
            label="Delete campaign"
            heading="Delete this campaign?"
            body="Deleting removes the campaign entry. You can't undo this."
            confirmLabel="Delete campaign"
            loading={busy === 'delete'}
            disabled={Boolean(busy)}
            onConfirm={() => submit('delete')}
          />
        )}
      </CampaignLifecycle>
    </s-page>
  );
}

// React Router replaces the nearest route with a boundary. Without one here, a failed
// load takes AppProvider and the app's navigation with it.
export function ErrorBoundary() {
  const error = useRouteError();
  // A response Shopify threw, such as a re-auth, renders the way the library expects.
  if (isRouteErrorResponse(error)) return boundary.error(error);
  const detail = error?.message ?? 'The load failed.';
  return (
    <s-page heading="Campaign">
      <s-section>
        <s-banner tone="critical" heading="Couldn't load campaign">
          <s-paragraph>{String(detail)}</s-paragraph>
        </s-banner>
        <s-box paddingBlockStart="base">
          <s-link href="/app/campaigns">Back to campaigns</s-link>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

import {Fragment, useState} from 'react';
import {redirect, useFetcher, useLoaderData, useRouteError} from 'react-router';
import {authenticate} from '../shopify.server';
import {
  eventTotal,
  funnelFitsWindow,
  funnelWindowEnd,
  sendCampaignFunnel,
  sendCount,
} from '../app-events.server';
import {
  deleteCampaign,
  findCampaign,
  readCampaigns,
  transportErrors,
  updateCampaign,
} from '../campaigns.server';
import {
  outcomeText,
  readSequence,
} from '../campaign-report.server';
import {
  ANNOTATION_DELETE,
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
  qrSalesQuery,
  runIfSupported,
  runOptional,
  salesQuery,
  sequenceQuery,
  targetsQuery,
  tierSalesQuery,
  touchSalesQuery,
} from '../campaign-queries.server';
import {
  campaignWindow,
  codeFilter,
  isPositiveAmount,
  parseProducts,
  productId,
  promotedFilter,
  promotedNames,
  safeLocale,
  shopMorning,
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
  closeCampaign,
  createAudienceTarget,
  createProductTarget,
  createStoreTarget,
  endTargetsOn,
  flagIncident,
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
import {CampaignLifecycle} from '../panels/close';
import {
  SalesAndOrders,
  StoreTotals,
  annotationStatus,
  metricCardQuery,
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
  // and takes the app's navigation with it. The search params hold App Bridge's store and host.
  const {admin, session} = await authenticate.admin(request);
  const {appId, campaigns} = await readCampaigns(admin);
  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) {
    return redirect(`/app/campaigns${new URL(request.url).search}`);
  }
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
  ] = await Promise.all([
    admin.graphql(salesQuery(campaign)).then((response) => response.json()),
    runIfSupported(admin, targetsQuery(campaign)),
    runIfSupported(admin, annotationsQuery(campaign)),
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
    // utm_medium is built in. The QR app writes it, the store reports it.
    runOptional(admin, qrSalesQuery(campaign)),
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

  const targets = await measureTargets(admin, campaign, targetsBody);

  // Each image encodes the code's scan URL. Render it where the merchant
  // plans the campaign, ready to print.
  const qrCodes = (
    await Promise.all(
      (campaign.qrCodes ?? []).map((handle) =>
        getQRCode(handle, admin.graphql, session.shop),
      ),
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
    qrCodes,
  };
}


// [START campaign-dashboard.lifecycle]
// One action for every write. Read the record, do what the intent names, write it back.
export async function action({request, params}) {
  const {admin} = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get('intent'));

  const [{appId, campaigns, failed}, shopBody] = await Promise.all([
    readCampaigns(admin),
    admin.graphql(SHOP_QUERY).then((response) => response.json()),
  ]);
  // Redirecting on a failed read would report the campaign gone.
  if (failed.length) return {problems: failed.map((error) => error.message)};

  const campaign = findCampaign(campaigns, params.campaignId);
  if (!campaign) {
    return redirect(`/app/campaigns${new URL(request.url).search}`);
  }

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

  // Timestamped in the shop's timezone.
  const markedAt = (date) =>
    new Date(shopMorning(date, timeZone)).toISOString();

  // `en-CA` formats as YYYY-MM-DD. Every date on a record is already in that shape.
  const shopToday = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  // Both edits move what a launched target filters on. Gate on the record's status,
  // the same field the panel reads before it offers the control.
  if (intent === 'set-products' || intent === 'set-audience') {
    if (campaign.status !== 'planned') {
      return {problems: ['Only a planned campaign can change this.']};
    }
  }

  if (intent === 'set-products') {
    const products = parseProducts(form.get('products'));
    if (products === null) {
      return {problems: ['Could not read the product selection.']};
    }
    const {userErrors} = await setProducts(admin, campaign, products);
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'set-audience') {
    const audience = String(form.get('audience'));
    // The tier becomes a ShopifyQL comparison and a target filter, both built as
    // strings. Only a value this app defines can reach them.
    if (!AUDIENCE_TIERS.some((tier) => tier.value === audience)) {
      return {problems: ['Pick a customer segment from the list.']};
    }
    const {userErrors} = await setAudience(admin, campaign, audience);
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'set-targets') {
    const amounts = {};
    // The form renders a field only for a target this campaign can launch, and a
    // segment of everyone has no segment target. Validate what came in, and leave
    // an absent amount at its saved value.
    for (const key of ['revenueTarget', 'productTarget', 'audienceTarget']) {
      if (!form.has(key)) continue;
      const value = String(form.get(key)).trim();
      if (!/^\d+(\.\d{1,2})?$/.test(value)) {
        return {problems: ['Enter each target amount as a number, such as 5000.']};
      }
      amounts[key] = value;
    }
    if (!Object.keys(amounts).length) {
      return {problems: ['Enter a target amount.']};
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
      return {problems: ['Only a running campaign can send its events.']};
    }
    // Shopify never deletes an accepted event, and every funnel query filters on
    // `campaign_id` alone. A second replay would sum both runs into one funnel and
    // measure every rate against a doubled denominator. The record is the gate,
    // because the funnel read behind the panel lags ingestion by minutes.
    if (campaign.sentEvents) {
      return {
        problems: [
          'This campaign already sent its events. Create a new campaign to send another run.',
        ],
      };
    }
    if (!funnelFitsWindow(campaign.startDate, campaign.endDate, timeZone)) {
      return {
        problems: [
          'This campaign ends before the two-week send schedule does. Extend the end date to at least 14 days after the start.',
        ],
      };
    }
    // The replay dates its events across the two weeks after the start date. A campaign
    // still mid-schedule would stamp the remainder ahead of today.
    const lastSend = funnelWindowEnd(campaign.startDate, timeZone);
    if (lastSend > Date.now()) {
      const day = new Date(lastSend).toISOString().slice(0, 10);
      return {problems: [`Wait until ${day}, when this campaign's last send lands.`]};
    }
    if (!shopId) return {problems: ['Could not read the store ID.']};
    const {accepted, failures} = await sendCampaignFunnel({
      shopId,
      campaignId: campaign.id,
      startDate: campaign.startDate,
      timeZone,
      channels: campaign.channels,
    });
    if (failures.length > 0) return {problems: failures};
    const sent = Object.values(accepted).reduce((total, n) => total + n, 0);
    const {userErrors} = await updateCampaign(admin, campaign.id, {sentEvents: sent});
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true, sentEvents: sent};
  }
  // [END campaign-dashboard.send-events-action]

  // Read by the launch and close branches below.
  const dimensions = await readDimensions(admin, appId);

  if (intent === 'launch') {
    // Gate on the record's status. A target the user set on the same date isn't
    // evidence that this campaign launched.
    if (campaign.status !== 'planned') {
      return {problems: ['This campaign has already been launched.']};
    }

    // Checked against the condition that creates each target.
    const unset = [];
    if (!isPositiveAmount(campaign.revenueTarget)) unset.push('store-wide revenue');
    if (promotedFilter(campaign) && !isPositiveAmount(campaign.productTarget)) {
      unset.push('promoted product');
    }
    if (
      isTargetedTier(campaign.audience) &&
      dimensions.customer?.enabled &&
      !isPositiveAmount(campaign.audienceTarget)
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

    // A launch that failed past this point left its IDs on the record. Reuse them,
    // or the retry creates a second set the app can never reach.
    const targets = {...(campaign.targets ?? {})};
    const rejected = [];
    if (!Object.keys(targets).length) {
      const [store, product, audience] = await Promise.all([
        createStoreTarget(admin, campaign),
        createProductTarget(admin, campaign),
        createAudienceTarget(admin, campaign, dimensions.customer),
      ]);
      for (const [key, result] of [
        ['store', store],
        ['product', product],
        ['audience', audience],
      ]) {
        if (result.id) targets[key] = result.id;
        rejected.push(...result.userErrors);
      }

      // Save the IDs before the stamps run, and delete what was created if that
      // write fails.
      const created = Object.values(targets);
      if (created.length) {
        const {userErrors: unsaved} = await updateCampaign(admin, campaign.id, {
          targets,
        });
        if (unsaved.length) {
          await admin.graphql(TARGETS_DELETE, {variables: {ids: created}});
          return {problems: unsaved.map((error) => error.message)};
        }
      }
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

    // A rejected target or stamp is a warning beside a launch that went through.
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
      return {problems: ['Only a running campaign can be rewritten.']};
    }
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
    // Targets exist from launch to close. Raising one after the outcome measured it
    // would leave the recorded result and the target disagreeing.
    if (campaign.status !== 'running') {
      return {problems: ['Only a running campaign can raise a target.']};
    }
    const targetsBody = await (
      await admin.graphql(targetsQuery(campaign))
    ).json();
    const target = recordedTarget(campaign, targetsBody, form.get('targetId'));
    if (!target?.shopifyqlQuery) return {problems: ['That target cannot be measured.']};

    const measured = await (
      await admin.graphql(measureQuery(target.shopifyqlQuery))
    ).json();
    const actual = progressValue(measured.data?.shopifyqlQuery);
    // A raise is permanent. An unmeasured target would move the goal to the floor.
    if (actual === null) {
      return {problems: ['This target came back unmeasured. Reload and raise it again.']};
    }
    const userErrors = await raiseTarget(admin, {...target, actual});
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'milestone') {
    if (campaign.status !== 'running') {
      return {problems: ['Only a running campaign can mark a milestone.']};
    }
    const day = String(form.get('day'));
    const targetsBody = await (
      await admin.graphql(targetsQuery(campaign))
    ).json();
    const target = recordedTarget(campaign, targetsBody, form.get('targetId'));
    if (!target) return {problems: ['That target no longer exists.']};

    // One mark per target per day. A second write would leave the first annotation
    // on the timeline with nothing pointing at it.
    const key = `milestone:${productId(target.id)}:${day}`;
    if (campaign.markers?.[key]) {
      return {problems: ['That day is already marked for this target.']};
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

  if (intent === 'flag-incident') {
    if (campaign.status !== 'running') {
      return {problems: ['Only a running campaign can flag an incident.']};
    }
    const day = String(form.get('day'));
    if (campaign.markers?.[`incident:${day}`]) {
      return {problems: ['That day already has an incident flagged.']};
    }

    const result = await flagIncident(admin, campaign, markedAt(day));
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

  if (intent === 'close') {
    // A closed campaign's outcome annotation is its permanent record, and measuring
    // again would rewrite it. The status write lands last, and a failed attempt
    // stays retryable.
    if (campaign.status !== 'running') {
      return {problems: ['Only a running campaign can be closed.']};
    }
    // A campaign can close before its window runs out. Everything below reads the
    // window that ran.
    const closedOn =
      shopToday < campaign.endDate ? shopToday : campaign.endDate;
    const closing = {...campaign, endDate: closedOn};

    // Shorten the targets first. A target left on its original end date keeps
    // measuring days the campaign didn't run, and Shopify rebuilds the query it
    // measures with from the dates.
    if (closedOn < campaign.endDate) {
      const stillOpen = await endTargetsOn(admin, campaign, closedOn);
      if (stillOpen.length) {
        return {problems: stillOpen.map((error) => error.message)};
      }
    }

    const [funnel, sequenceTable, targetsBody] = await Promise.all([
      runOptional(admin, appEventsQuery(closing)),
      runOptional(admin, sequenceQuery(closing)),
      admin.graphql(targetsQuery(closing)).then((response) => response.json()),
    ]);

    // A failed read returns no nodes, the same shape as a deleted target. Closing
    // is permanent. Only the deleted case is allowed through.
    if (targetsBody.errors?.length) {
      return {problems: ['The targets read failed. Reload and close it again.']};
    }

    // The ID the launch recorded. A target the user made on the same date
    // measures the same days without being this campaign's.
    const store = (targetsBody.data?.analyticsTargets?.nodes ?? []).find(
      (node) => node.id === campaign.targets?.store,
    );
    const measured = store?.shopifyqlQuery
      ? await (await admin.graphql(measureQuery(store.shopifyqlQuery))).json()
      : null;
    const measurement = progressValue(measured?.data?.shopifyqlQuery);
    // Closing is permanent, and a failed read would record the campaign at zero. A
    // target that no longer exists never measures. Closing stays available.
    if (measured && measurement === null) {
      return {problems: ['This target came back unmeasured. Reload and close it again.']};
    }
    const revenue = measurement ?? 0;

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

    // Attribution needs the orders to exist, and close is the first point they do.
    // Skipped until the definition is a dimension.
    const unattributed = dimensions.order.enabled
      ? await stampOrders(admin, closing)
      : [];
    if (unattributed.length) {
      return {problems: unattributed.map((error) => error.message)};
    }

    const {userErrors} = await updateCampaign(admin, campaign.id, {
      status: 'closed',
      endDate: closedOn,
    });
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true, funnelRows: funnel.tableData.rows.length};
  }

  if (intent === 'cancel') {
    // A closed campaign keeps its outcome on the store's charts. A cancel only takes
    // down a planned or running one.
    if (campaign.status !== 'planned' && campaign.status !== 'running') {
      return {problems: ['Only a planned or running campaign can be canceled.']};
    }
    // Only the IDs on the record. `analyticsTargetsDelete` deletes any target on the
    // shop, including the targets the user set. Each ID drops off the record as its delete lands.
    const undone = [];
    const markers = {};
    for (const [key, id] of Object.entries(campaign.markers ?? {})) {
      const body = await (
        await admin.graphql(ANNOTATION_DELETE, {variables: {id}})
      ).json();
      const errors = [
        ...transportErrors(body),
        ...(body.data?.analyticsAnnotationDelete?.userErrors ?? []),
      ];
      if (errors.length) {
        markers[key] = id;
        undone.push(...errors);
      }
    }

    const targets = {...campaign.targets};
    const ids = Object.values(targets);
    if (ids.length > 0) {
      const body = await (
        await admin.graphql(TARGETS_DELETE, {variables: {ids}})
      ).json();
      const result = body.data?.analyticsTargetsDelete;
      undone.push(...transportErrors(body), ...(result?.userErrors ?? []));
      for (const deleted of result?.deletedIds ?? []) {
        const key = Object.keys(targets).find((name) => targets[name] === deleted);
        if (key) delete targets[key];
      }
    }

    // Clearing the record on a failed delete abandons what's still on the timeline. The
    // IDs are the only handle the app has on it.
    if (undone.length) {
      const {userErrors} = await updateCampaign(admin, campaign.id, {
        markers,
        targets,
      });
      return {problems: [...undone, ...userErrors].map((error) => error.message)};
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
    // Launching records new target IDs over the old ones. Replanning a live campaign
    // would leave its targets on the store with nothing pointing at them.
    if (campaign.status !== 'canceled') {
      return {problems: ['Only a canceled campaign can be planned again.']};
    }
    // Canceling already took everything off the store, leaving the same state a
    // planned campaign is in.
    const {userErrors} = await updateCampaign(admin, campaign.id, {status: 'planned'});
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return {ok: true};
  }

  if (intent === 'delete') {
    // A canceled campaign holds nothing on the store. Deleting any other status
    // would abandon its annotations and targets on the charts.
    if (campaign.status !== 'canceled') {
      return {problems: ['Only a canceled campaign can be deleted.']};
    }
    const {userErrors} = await deleteCampaign(admin, campaign.id);
    if (userErrors.length) {
      return {problems: userErrors.map((error) => error.message)};
    }
    return redirect('/app/campaigns');
  }

  return {problems: [`Unknown intent: ${intent}`]};
}
// [END campaign-dashboard.lifecycle]

// [START campaign-dashboard.unavailable-note]
// A query that never ran looks like a store that sold nothing. Only the failure is actionable.
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


export default function CampaignDashboard() {
  const data = useLoaderData();
  const fetcher = useFetcher();

  const cardReady = useMetricCardsReady();

  const [range, setRange] = useState('last30days');

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
    promoted,
    tierSales,
    touchSales,
    codeSales,
    qrSales,
    qrCodes,
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
  // [END campaign-dashboard.totals]

  const {storeTarget, scopedTargets} = splitTargets(targets);

  const {marks, ours, openCampaign, incidentFlagged} = annotationStatus({
    campaign,
    annotations,
    appId,
  });

  // The same conditions the launch applies.
  const plannedTargetCount =
    1 +
    (campaign.products.length > 0 ? 1 : 0) +
    (isTargetedTier(campaign.audience) && dimensions.customer.enabled ? 1 : 0);

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
    totalSales,
    cell,
    rate,
  });

  const problems = fetcher.data?.problems ?? [];
  // Problems alongside `ok` mean the action landed with something rejected inside it.
  const partial = Boolean(fetcher.data?.ok);
  const busy = fetcher.state !== 'idle';
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

  // Beside the store's totals on a launched campaign, alone before one.
  const statusLine = (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-badge
        tone={
          {
            planned: 'info',
            running: 'caution',
            closed: 'success',
            canceled: 'critical',
          }[campaign.status]
        }
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
            today <= campaign.endDate ? dayGap(today, campaign.endDate) + 1 : 0;
          const earned = Number(storeTarget.actual ?? 0);
          const short = Math.max(0, Number(storeTarget.expectedValue) - earned);
          return {perDay: earned / elapsed, needed: left > 0 ? short / left : short, left};
        })()
      : null;

  const markNote =
    !planned && ours.length === 0
      ? "This campaign has no annotations in the store's analytics."
      : ours.length > marks.length
        ? `${ours.length - marks.length} annotations are left over from earlier ` +
          `marks on this campaign. Rewriting replaces them with the current ${marks.length}.`
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
      {/* Before a launch there are no totals to sit beside. Launch and Cancel are
          the only actions, so they share the top of the page. */}
      {planned && (
        <s-section>
          <s-stack direction="block" gap="base">
            {statusLine}
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" loading={busy} onClick={() => submit('launch')}>
                Launch the campaign
              </s-button>
              <s-button tone="critical" loading={busy} onClick={() => submit('cancel')}>
                Cancel the campaign
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}
      {/* [END campaign-dashboard.status-render] */}

      {planned && (
        <Fragment>
          {/* Everything the launch will write, listed before it writes it. */}
          <s-section heading="Campaign setup">
            <div style={{height: '12px'}} />
            <s-paragraph>Launch writes three things to the store:</s-paragraph>
            <s-unordered-list>
              <s-list-item>
                {marks.length} annotations to the store's analytics. One spans
                the campaign's run.
              </s-list-item>
              <s-list-item>
                {plannedTargetCount} analytics{' '}
                {plannedTargetCount === 1 ? 'target' : 'targets'} for{' '}
                {shortDate(campaign.startDate)} to {shortDate(campaign.endDate)}.
              </s-list-item>
              <s-list-item>
                A <s-text>promoted_by</s-text> stamp on{' '}
                {campaign.products.length === 0
                  ? 'the products you select'
                  : `${campaign.products.length} ${
                      campaign.products.length === 1 ? 'product' : 'products'
                    }`}
                {isTargetedTier(campaign.audience)
                  ? ` and a tier tag on each ${tierLabel(campaign.audience)} customer.`
                  : '. The segment is the whole store.'}
              </s-list-item>
            </s-unordered-list>

            <div style={{height: '12px'}} />

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

          {/* [START campaign-dashboard.qr-setup-render] */}
          <s-section heading="QR code">
            <div style={{height: '12px'}} />
            {(qrCodes ?? []).length > 0 ? (
              <s-stack direction="block" gap="base">
                <s-text>
                  Print the code, or scan it from the screen. Scans land on
                  the code's product with the campaign's UTM parameters, and
                  the QR code sales panel reports the orders shoppers place
                  after scanning.
                </s-text>
                {qrCodes.map((code) => (
                  <s-stack key={code.handle} direction="block" gap="small-200">
                    {code.productTitle && (
                      <s-text>
                        This QR code opens the {code.productTitle} product
                        page where a customer can add it to their cart or buy
                        now.
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
                        alt={`The QR code for ${campaign.title}`}
                      />
                      <s-link href={`/app/qrcodes/${code.handle}`}>
                        Manage this code
                      </s-link>
                    </s-stack>
                  </s-stack>
                ))}
              </s-stack>
            ) : (
              <s-text>
                This campaign has no QR code. Create one on the{' '}
                <s-link href="/app/qrcodes/new">QR codes page</s-link> with
                the campaign's name, and while the campaign runs the QR code
                sales panel reports the orders shoppers place after scanning.
              </s-text>
            )}
          </s-section>
          {/* [END campaign-dashboard.qr-setup-render] */}

          {/* Each amount becomes a target at launch, and launch rejects a zero. */}
          <form onSubmit={saveTargets}>
            <s-section heading="Targets">
              <div style={{height: '12px'}} />
              <s-stack direction="block" gap="base">
                <s-money-field
                  label="Store-wide revenue target"
                  name="revenueTarget"
                  value={campaign.revenueTarget}
                  min={0}
                  details="Measured on total sales."
                />
                <s-money-field
                  label="Promoted product target"
                  name="productTarget"
                  value={campaign.productTarget}
                  min={0}
                  details={promotedNames(campaign) || 'No products selected'}
                />
                {isTargetedTier(campaign.audience) && (
                  <s-money-field
                    label="Customer segment target"
                    name="audienceTarget"
                    value={campaign.audienceTarget}
                    min={0}
                    details={`Sales to the ${tierLabel(campaign.audience)} segment`}
                  />
                )}
                <s-button variant="primary" type="submit" loading={busy}>
                  Save targets
                </s-button>
              </s-stack>
            </s-section>
          </form>
        </Fragment>
      )}

      {/* A campaign that hasn't launched has nothing attributed to it. Reporting the
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
          alreadySent={Boolean(campaign.sentEvents)}
          sentEvents={fetcher.data?.sentEvents}
          integer={integer}
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

      <CampaignLifecycle
        campaign={campaign}
        openCampaign={openCampaign}
        closesOn={closesOn}
        running={running}
        busy={busy}
        submit={submit}
        shortDate={shortDate}
      >
        {campaign.status === 'canceled' && (
          <s-button tone="critical" loading={busy} onClick={() => submit('delete')}>
            Delete the campaign
          </s-button>
        )}
      </CampaignLifecycle>
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

import {isRouteErrorResponse, useLoaderData, useRouteError} from 'react-router';
import {boundary} from '@shopify/shopify-app-react-router/server';
import {authenticate} from '../shopify.server';
import {findCampaign, readCampaigns, withReturnedErrors} from '../campaigns.server';
import {
  codeSalesQuery,
  emptyTable,
  promotedByQuery,
  qrFunnelQuery,
  qrSalesQuery,
  runOptional,
  salesQuery,
  topProductsQuery,
  tierSalesQuery,
  touchSalesQuery,
} from '../campaign-queries.server';
import {campaignWindow, codeFilter, qrHandleFilter, safeLocale, statusLabel} from '../campaigns';
import {CHANNELS} from '../channels';
import {
  SalesAndOrders,
  TopProducts,
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
import {isTargetedTier, tierLabel} from '../audiences';
import {analyticsReportHref} from '../annotations';
import {readDimensions} from '../dimensions.server';
import {queryShopifyQL} from '../shopifyql.server';

export async function loader({request, params}) {
  // [START campaign-dashboard.campaign-load]
  // Redirect on a miss. A thrown response renders above this route's layout
  // and takes the app's navigation with it. The redirect keeps App Bridge's search params.
  const {admin: client, session, redirect} = await authenticate.admin(request);
  const admin = withReturnedErrors(client);
  const {appId, campaigns, failed} = await readCampaigns(admin, session.shop);
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
    promoted,
    tierSales,
    touchSales,
    codeSales,
    qrSales,
    qrFunnel,
    topProducts,
  ] = await Promise.all([
    queryShopifyQL(admin, salesQuery(campaign)),
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

  return {
    campaign,
    locale,
    fatal: null,
    // The sales schema has no currency column. Read it off the shop field.
    currencyCode: salesBody.data?.shop?.currencyCode ?? 'USD',
    queryWindow,
    dimensions,
    rows: sales.tableData.rows,
    promoted,
    tierSales,
    touchSales,
    codeSales,
    qrSales,
    qrFunnel,
    topProducts,
  };
}

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

  const cardReady = useMetricCardsReady();

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
    currencyCode,
    queryWindow,
    dimensions,
    rows,
    promoted,
    tierSales,
    touchSales,
    codeSales,
    qrSales,
    qrFunnel,
    topProducts,
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

  // A bare YYYY-MM-DD is UTC midnight, a day early west of it. Append a time.
  const asLocalDay = (day) => new Date(`${day}T00:00:00`);

  const shortDate = (day) =>
    new Intl.DateTimeFormat(locale, {month: 'short', day: 'numeric'}).format(
      asLocalDay(day),
    );

  const percent = (value) =>
    value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  // [END campaign-dashboard.format]

  const {totalSales, percentChange, yearChange, newCustomers, firstTimeSales} =
    salesTotals(rows);

  const {productRows, otherSales} = topProductsShape({topProducts, cell});

  const rate = (value, base) => (base > 0 ? (value / base) * 100 : 0);

  const exploreHref = analyticsReportHref({window: queryWindow, annotations: []});

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

  return (
    <s-page heading={campaign.title}>
      <s-section>{statusLine}</s-section>

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
        exploreHref={exploreHref}
        currency={currency}
        percent={percent}
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

      <Unavailable heading="Order attribution" reason={touchSales.unavailable} />

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

import {useState} from 'react';

import {annotateClause, exploreLink} from '../annotations';
import {
  campaignWindow,
  creatorCodes,
  creatorTouches,
  qrHandleFilter,
  qrTitle,
  touchMarks,
} from '../campaigns';
import {tierLabel} from '../audiences';

import {PanelHeader, sharePercent} from './shared';

// [START campaign-dashboard.promoted-split]
export function promotedShape({promoted, campaign, totalSales, cell, rate}) {
  const promotedByDay = new Map();
  const otherByDay = new Map();
  for (const row of promoted.tableData.rows ?? []) {
    const day = String(cell(row, 'day'));
    // The reference resolves to the entry's campaign_id, as a string. Titles repeat.
    const bucket =
      String(cell(row, 'promoted_by') ?? '') === String(campaign.id)
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

  return {
    promotedRows: promotedDays.map((day) => ({
      day,
      promoted: promotedByDay.get(day) ?? 0,
      rest: otherByDay.get(day) ?? 0,
    })),
    promotedSales,
    promotedShare: rate(promotedSales, Number(totalSales)),
  };
}
// [END campaign-dashboard.promoted-split]

// [START campaign-dashboard.tier-shape]
// A tier the app wrote is a dimension like any other once it's queryable.
export function tierShape({tierSales, totalSales, cell, rate}) {
  const tierRows = (tierSales.tableData.rows ?? []).map((row) => ({
    day: String(cell(row, 'day')),
    sales: Number(cell(row, 'total_sales') ?? 0),
  }));
  const tierTotal = tierRows.reduce((running, row) => running + row.sales, 0);

  return {tierRows, tierTotal, tierShare: rate(tierTotal, Number(totalSales))};
}
// [END campaign-dashboard.tier-shape]

// [START campaign-dashboard.touch-shape]
// The column holds every closed campaign. The filter narrows it to this one.
export function touchShape({touchSales, campaign, cell}) {
  const titles = touchMarks(campaign).map((mark) => mark.title);
  return (touchSales.tableData.rows ?? [])
    .map((row) => ({
      touch: String(cell(row, 'touch') ?? ''),
      sales: Number(cell(row, 'total_sales') ?? 0),
      orders: Number(cell(row, 'orders') ?? 0),
    }))
    .filter((row) => titles.includes(row.touch));
}
// [END campaign-dashboard.touch-shape]

// [START campaign-dashboard.code-shape]
// `discount_code` is built in. The store has no idea two codes are one creator's.
export function creatorShape({codeSales, campaign, touchRows, cell}) {
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
  const creatorTouchTitles = creatorTouches(campaign);

  return {
    creatorRows,
    codeTotal: creatorRows.reduce((running, row) => running + row.sales, 0),
    touchedTotal: touchRows
      .filter((row) => creatorTouchTitles.includes(row.touch))
      .reduce((running, row) => running + row.sales, 0),
  };
}
// [END campaign-dashboard.code-shape]

// [START campaign-dashboard.qr-shape]
// Funnel rates are fractions of each code's sessions. A code with scans and no
// order still gets a row.
export function qrShape({qrSales, qrFunnel, totalSales, cell, rate}) {
  const funnel = new Map(
    (qrFunnel?.tableData.rows ?? []).map((row) => [
      String(cell(row, 'utm_campaign') ?? ''),
      {
        sessions: Number(cell(row, 'campaign_sessions') ?? 0),
        cartRate: Number(cell(row, 'campaign_added_to_cart_rate') ?? 0),
        conversionRate: Number(cell(row, 'campaign_conversion_rate') ?? 0),
      },
    ]),
  );
  const sold = (qrSales.tableData.rows ?? [])
    .map((row) => ({
      code: String(cell(row, 'utm_campaign') ?? ''),
      sales: Number(cell(row, 'campaign_last_non_direct_click_total_sales') ?? 0),
      orders: Number(cell(row, 'campaign_last_non_direct_click_order_count') ?? 0),
    }))
    .filter((row) => row.sales > 0);
  const scannedOnly = [...funnel.entries()]
    .filter(([code, visits]) => visits.sessions > 0 && !sold.some((row) => row.code === code))
    .map(([code]) => ({code, sales: 0, orders: 0}));
  const qrRows = [...sold, ...scannedOnly].map((row) => ({
    ...row,
    ...(funnel.get(row.code) ?? {sessions: null, cartRate: null, conversionRate: null}),
  }));
  const qrTotal = qrRows.reduce((running, row) => running + row.sales, 0);
  return {qrRows, qrTotal, qrShare: rate(qrTotal, Number(totalSales))};
}
// [END campaign-dashboard.qr-shape]

// [START campaign-dashboard.promoted-render]
export function PromotedProductSales({
  promotedRows,
  promotedSales,
  promotedShare,
  totalSales,
  dimensions,
  currency,
  shortDate,
}) {
  const [showDays, setShowDays] = useState(false);
  if (!promotedRows.some((row) => row.promoted > 0)) return null;

  return (
    <s-section id="promoted">
      <PanelHeader
        title="Promoted product sales"
        uses={{
          shopifyql:
            "Groups the store's daily sales by the campaign that promoted each product.",
          metafields: 'Links each promoted product to its campaign.',
        }}
      />
      {Number(totalSales) > 0 ? (
        <s-paragraph>
          Promoted products earned {currency(promotedSales)},{' '}
          {sharePercent(promotedShare)} of {currency(totalSales)} in store sales.
        </s-paragraph>
      ) : (
        <s-paragraph>
          Promoted products earned {currency(promotedSales)}. Store sales totals
          aren&rsquo;t available for this period yet.
        </s-paragraph>
      )}
      <s-paragraph>
        This report groups sales by the campaign ID on each product&rsquo;s{' '}
        <s-text type="strong">{dimensions.product.name}</s-text> metafield.
      </s-paragraph>
      <s-button variant="tertiary" onClick={() => setShowDays(!showDays)}>
        {showDays ? 'Hide daily breakdown' : 'Show daily breakdown'}
      </s-button>
      {showDays && (
        <s-box paddingBlockStart="base">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Day</s-table-header>
              <s-table-header listSlot="labeled">Promoted products</s-table-header>
              <s-table-header listSlot="labeled">Other products</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {promotedRows.map((row) => (
                <s-table-row key={row.day}>
                  <s-table-cell>{shortDate(row.day)}</s-table-cell>
                  <s-table-cell>{currency(row.promoted)}</s-table-cell>
                  <s-table-cell>{currency(row.rest)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-box>
      )}
    </s-section>
  );
}
// [END campaign-dashboard.promoted-render]

// [START campaign-dashboard.tier-render]
// The tier came from the app, the sales from the store.
export function SegmentSales({
  campaign,
  tierRows,
  tierTotal,
  tierShare,
  totalSales,
  currency,
  shortDate,
}) {
  const [showDays, setShowDays] = useState(false);
  if (tierRows.length === 0) return null;

  return (
    <s-section id="audience-sales">
      <PanelHeader
        title={`${tierLabel(campaign.audience)} segment sales`}
        uses={{
          shopifyql:
            "Filters the store's daily sales to the tier this campaign targeted.",
          metafields:
            'Writes the tier onto each customer to make it queryable.',
        }}
      />
      {Number(totalSales) > 0 ? (
        <s-paragraph>
          {tierLabel(campaign.audience)} customers spent {currency(tierTotal)},{' '}
          {sharePercent(tierShare)} of {currency(totalSales)} in store sales.
        </s-paragraph>
      ) : (
        <s-paragraph>
          {tierLabel(campaign.audience)} customers spent {currency(tierTotal)}. Store
          sales totals aren&rsquo;t available for this period yet.
        </s-paragraph>
      )}
      <s-button variant="tertiary" onClick={() => setShowDays(!showDays)}>
        {showDays ? 'Hide daily breakdown' : 'Show daily breakdown'}
      </s-button>
      {showDays && (
        <s-box paddingBlockStart="base">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Day</s-table-header>
              <s-table-header listSlot="labeled">Sales</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {tierRows.map((row) => (
                <s-table-row key={row.day}>
                  <s-table-cell>{shortDate(row.day)}</s-table-cell>
                  <s-table-cell>{currency(row.sales)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-box>
      )}
    </s-section>
  );
}
// [END campaign-dashboard.tier-render]

// [START campaign-dashboard.touch-render]
export function OrderAttribution({touchRows, dimensions, currency}) {
  if (touchRows.length === 0) return null;

  return (
    <s-section id="touch-sales">
      <PanelHeader
        title="Order attribution"
        uses={{
          shopifyql: "Groups the campaign's sales by the touch each order followed.",
          metafields: 'Writes the touch onto each order when the campaign closes.',
        }}
      />
      <s-paragraph>
        When the campaign closes, the app writes each order&rsquo;s last campaign touch to the
        order&rsquo;s <s-text type="strong">{dimensions.order.name}</s-text> metafield. This
        report groups sales by the last touch.
      </s-paragraph>
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">Last touch</s-table-header>
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
  );
}
// [END campaign-dashboard.touch-render]

// [START campaign-dashboard.code-render]
// What the codes prove against what the posts moved.
export function CreatorRevenue({creatorRows, codeTotal, touchedTotal, currency}) {
  if (creatorRows.length === 0) return null;

  return (
    <s-section id="creator-codes">
      <PanelHeader
        title="Creator revenue"
        uses={{
          shopifyql:
            'Filters sales to the discount codes this campaign gave its creators.',
        }}
      />
      <s-paragraph>
        This report groups sales from this campaign&rsquo;s discount codes by the
        creator who shares each code.
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
          Sales with a creator code: {currency(codeTotal)}. Sales from orders whose
          last campaign touch was a creator post:{' '}
          <s-text type="strong">{currency(touchedTotal)}</s-text>.
        </s-paragraph>
      )}
    </s-section>
  );
}
// [END campaign-dashboard.code-render]

// [START campaign-dashboard.qr-card]
// The same query draws the in-app card and, through the explore link, the full
// report in the store's analytics dashboard, annotations included.
export function qrCardQuery(campaign) {
  return [
    'FROM campaign_sales',
    'SHOW campaign_last_non_direct_click_total_sales',
    'TIMESERIES day',
    `WHERE utm_medium = 'qr' AND ${qrHandleFilter(campaign)}`,
    campaignWindow(campaign),
    'VISUALIZE campaign_last_non_direct_click_total_sales TYPE bar',
    `ANNOTATE ${annotateClause(['campaign'])}`,
  ].join(' ');
}
// [END campaign-dashboard.qr-card]

// [START campaign-dashboard.qr-render]
// The scans came from the QR app, the attribution from the store.
export function QRCodeSales({
  campaign,
  cardReady,
  qrRows,
  qrTotal,
  qrShare,
  totalSales,
  currency,
}) {
  if (qrRows.length === 0) return null;

  const ofSessions = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);

  return (
    <s-section id="qr-sales">
      <PanelHeader
        title="QR code sales"
        uses={{
          shopifyql:
            "Filters attributed sales to orders that started from a scan of this campaign's QR codes, and sessions to the visits a scan started.",
          annotations:
            "ANNOTATE draws the campaign's marks from the store's timeline onto the chart.",
          components: 'A Shopify metric card, running the query it displays.',
        }}
      />
      <s-box paddingBlockEnd="base">
        <s-box blockSize="320px">
          {cardReady ? (
            <s-shopifyql-metric-card
              heading="QR code sales by day"
              query={qrCardQuery(campaign)}
            />
          ) : (
            <s-spinner accessibilityLabel="Loading the QR sales chart" />
          )}
        </s-box>
      </s-box>
      {/* Attribution can credit an order whose session predates the window. The QR
          total can outrun the store's daily dataset. No total, no share. */}
      {Number(totalSales) > 0 ? (
        <s-paragraph>
          QR code orders earned {currency(qrTotal)}, {sharePercent(qrShare)} of{' '}
          {currency(totalSales)} in store sales.
        </s-paragraph>
      ) : (
        <s-paragraph>
          QR code orders earned {currency(qrTotal)}. Store sales totals
          aren&rsquo;t available for this period yet.
        </s-paragraph>
      )}
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">QR code</s-table-header>
          <s-table-header listSlot="labeled">Sessions</s-table-header>
          <s-table-header listSlot="labeled">Added to cart</s-table-header>
          <s-table-header listSlot="labeled">Conversion</s-table-header>
          <s-table-header listSlot="labeled">Orders</s-table-header>
          <s-table-header listSlot="labeled">Attributed sales</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {qrRows.map((row) => (
            <s-table-row key={row.code}>
              <s-table-cell>{qrTitle(campaign, row.code)}</s-table-cell>
              <s-table-cell>{row.sessions ?? '—'}</s-table-cell>
              <s-table-cell>{ofSessions(row.cartRate)}</s-table-cell>
              <s-table-cell>{ofSessions(row.conversionRate)}</s-table-cell>
              <s-table-cell>{row.orders}</s-table-cell>
              <s-table-cell>{currency(row.sales)}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
      <s-box paddingBlockStart="base">
        <s-link href={exploreLink(qrCardQuery(campaign))} target="_blank">
          Open in Analytics
        </s-link>
      </s-box>
    </s-section>
  );
}
// [END campaign-dashboard.qr-render]

import {annotateClause, exploreLink} from '../annotations';
import {campaignWindow, creatorCodes, creatorTouches, touchMarks} from '../campaigns';
import {tierLabel} from '../audiences';

import {PanelHeader} from './shared';

// [START campaign-dashboard.promoted-split]
export function promotedShape({promoted, campaign, totalSales, cell, rate}) {
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
export function qrShape({qrSales, totalSales, cell, rate}) {
  const qrRows = (qrSales.tableData.rows ?? [])
    .map((row) => ({
      code: String(cell(row, 'utm_campaign') ?? ''),
      sales: Number(cell(row, 'campaign_last_non_direct_click_total_sales') ?? 0),
      orders: Number(cell(row, 'campaign_last_non_direct_click_order_count') ?? 0),
    }))
    .filter((row) => row.code && row.sales > 0);
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
  if (!promotedRows.some((row) => row.promoted > 0)) return null;

  return (
    <s-section id="promoted">
      <PanelHeader
        title="Promoted product sales"
        uses={{
          shopifyql:
            "Groups the store's daily sales by the campaign that promoted each product.",
          metafields: 'Stamps every promoted product with the campaign name at launch.',
        }}
      />
      {Number(totalSales) > 0 ? (
        <s-paragraph>
          Products this campaign promoted earned {currency(promotedSales)} of the store's{' '}
          {currency(totalSales)}, or {promotedShare.toFixed(0)}%.
        </s-paragraph>
      ) : (
        <s-paragraph>
          Products this campaign promoted earned {currency(promotedSales)}. The
          store&rsquo;s sales dataset shows no total for this window yet.
        </s-paragraph>
      )}
      <s-paragraph>
        The store grouped that split by{' '}
        <s-text type="strong">{dimensions.product.dimension}</s-text>, the dimension
        this app created.
      </s-paragraph>
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">Day</s-table-header>
          <s-table-header listSlot="labeled">Promoted products</s-table-header>
          <s-table-header listSlot="labeled">The rest of the store</s-table-header>
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
          The segment this campaign targeted bought {currency(tierTotal)} of the store's{' '}
          {currency(totalSales)} over the same window, or {tierShare.toFixed(0)}%.
        </s-paragraph>
      ) : (
        <s-paragraph>
          The segment this campaign targeted bought {currency(tierTotal)}. The
          store&rsquo;s sales dataset shows no total for this window yet.
        </s-paragraph>
      )}
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
        Each order stores the last campaign touch before it, written to{' '}
        <s-text type="strong">{dimensions.order.dimension}</s-text> when the campaign
        closed. The store groups its sales by that column.
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
        The store already records <s-text type="strong">discount_code</s-text>. Grouping several codes under one creator is the part only
        this app can do, because only it knows who hands out which code.
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
          Codes were entered on {currency(codeTotal)}. Orders that followed a creator
          post without one bring the creators&rsquo; total to{' '}
          <s-text type="strong">{currency(touchedTotal)}</s-text>. The difference is
          what the codes couldn&rsquo;t prove.
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
    "WHERE utm_medium = 'qr'",
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

  return (
    <s-section id="qr-sales">
      <PanelHeader
        title="QR code sales"
        uses={{
          shopifyql:
            'Filters attributed sales to orders that started from a QR code scan.',
          annotations:
            "ANNOTATE draws the campaign's marks from the store's timeline onto the chart.",
          components: 'A Shopify metric card, running the query it displays.',
        }}
      />
      <div style={{height: '320px', marginBottom: '16px'}}>
        {cardReady ? (
          <s-shopifyql-metric-card
            heading="QR sales by day"
            query={qrCardQuery(campaign)}
          />
        ) : (
          <s-spinner accessibilityLabel="Loading the QR sales chart" />
        )}
      </div>
      {/* Attribution can credit an order whose session predates the window, so the
          QR total can outrun the store's daily dataset. No total, no share. */}
      {Number(totalSales) > 0 ? (
        <s-paragraph>
          Orders attributed to a QR code scan bought {currency(qrTotal)} of the
          store&rsquo;s {currency(totalSales)} over the same window, or{' '}
          {qrShare.toFixed(0)}%.
        </s-paragraph>
      ) : (
        <s-paragraph>
          Orders attributed to a QR code scan bought {currency(qrTotal)}. The
          store&rsquo;s sales dataset shows no total for this window yet.
        </s-paragraph>
      )}
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">QR code</s-table-header>
          <s-table-header listSlot="labeled">Orders</s-table-header>
          <s-table-header listSlot="labeled">Attributed sales</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {qrRows.map((row) => (
            <s-table-row key={row.code}>
              <s-table-cell>{row.code}</s-table-cell>
              <s-table-cell>{row.orders}</s-table-cell>
              <s-table-cell>{currency(row.sales)}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
      <s-box paddingBlockStart="base">
        <s-link href={exploreLink(qrCardQuery(campaign))} target="_blank">
          Open this report in the store&rsquo;s analytics dashboard
        </s-link>
      </s-box>
    </s-section>
  );
}
// [END campaign-dashboard.qr-render]

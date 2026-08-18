import {LineChart, PolarisVizProvider, StackedAreaChart} from '@shopify/polaris-viz';

import {creatorCodes, creatorTouches, touchMarks} from '../campaigns';
import {tierLabel} from '../audiences';

import {PanelHeader} from './shared';

// [START campaign-dashboard.promoted-split]
// What the campaign promoted against what the store sold anyway, day by day. Unstamped
// products come back under an empty value, which is the rest of the store.
export function promotedSeries({promoted, campaign, totalSales, cell, rate, shortDate}) {
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
    promotedByDay,
    promotedSales,
    promotedShare: rate(promotedSales, Number(totalSales)),
    promotedSplit: [
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
    ],
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
// One row per send, narrowed to this campaign. The column holds every closed
// campaign. Unattributed orders come back under an empty value.
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

// [START campaign-dashboard.promoted-render]
// The split the app's own dimension makes possible.
export function PromotedProductSales({
  promotedByDay,
  promotedSplit,
  promotedSales,
  promotedShare,
  totalSales,
  dimensions,
  isClient,
  currency,
}) {
  if (promotedByDay.size === 0) return null;

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
      <s-paragraph>
        {currency(promotedSales)} of {currency(totalSales)} came from products this
        campaign promoted, which is {promotedShare.toFixed(0)}% of what the store sold.
      </s-paragraph>
      <s-paragraph>
        The store grouped that split by{' '}
        <s-text type="strong">{dimensions.product.dimension}</s-text>, the dimension
        this app created.
      </s-paragraph>
      {isClient && (
        <div className="chart-tooltip-fix" style={{height: '260px'}}>
          <PolarisVizProvider>
            <StackedAreaChart data={promotedSplit} theme="Light" />
          </PolarisVizProvider>
        </div>
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
  isClient,
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
            'Writes that tier onto each customer, which is what makes it queryable.',
        }}
      />
      <s-paragraph>
        {currency(tierTotal)} of {currency(totalSales)} came from the segment this
        campaign targeted, which is {tierShare.toFixed(0)}% of the store's sales over
        the same window.
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
  );
}
// [END campaign-dashboard.tier-render]

// [START campaign-dashboard.touch-render]
// Per-order attribution splits revenue between the sends.
export function OrderAttribution({touchRows, dimensions, currency}) {
  if (touchRows.length === 0) return null;

  return (
    <s-section id="touch-sales">
      <PanelHeader
        title="Order attribution"
        uses={{
          shopifyql: "Groups the campaign's sales by the touch each order followed.",
          metafields: 'Writes that touch onto each order when the campaign closes.',
        }}
      />
      <s-paragraph>
        Each order stores the last campaign touch before it, written to{' '}
        <s-text type="strong">{dimensions.order.dimension}</s-text> when the campaign
        closed. The store groups its own sales by that column.
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
        Code revenue comes from <s-text type="strong">discount_code</s-text>, which the
        store already has. Grouping several codes under one creator is the part only
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

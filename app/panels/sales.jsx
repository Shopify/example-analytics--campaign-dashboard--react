import {Fragment, useEffect, useState} from 'react';
import {ComboChart, PolarisVizProvider} from '@shopify/polaris-viz';

import {annotationColor, categoryLegend} from '../annotations';
import {campaignMarks, clamp} from '../campaigns';

import {PanelHeader} from './shared';

const SINCE_BY_RANGE = {
  today: 'today',
  last7days: 'startOfDay(-7d)',
  last30days: 'startOfDay(-30d)',
  last90days: 'startOfDay(-90d)',
  last365days: 'startOfDay(-365d)',
};

// [START campaign-dashboard.client-only]
// Polaris Viz measures the element it draws into. Gate every chart on mount.
export function useIsClient() {
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);
  return isClient;
}
// [END campaign-dashboard.client-only]

// [START campaign-dashboard.metric-card-ready]
// A metric card needs `window.shopify.shopifyQL`, installed after load. Wait on the
// API itself.
export function useMetricCardsReady() {
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
  return cardReady;
}
// [END campaign-dashboard.metric-card-ready]

// [START campaign-dashboard.chart]
// Money and a count can't share an axis. A ComboChart gives each one an axis.
export function salesChartSeries({rows, cell, shortDate}) {
  return {
    salesSeries: {
      name: 'Sales',
      data: rows.map((row) => ({
        key: shortDate(cell(row, 'day')),
        value: Number(cell(row, 'total_sales') ?? 0),
      })),
    },
    ordersSeries: {
      name: 'Orders',
      data: rows.map((row) => ({
        key: shortDate(cell(row, 'day')),
        value: Number(cell(row, 'orders') ?? 0),
      })),
    },
  };
}
// [END campaign-dashboard.chart]

// [START campaign-dashboard.metric-card]
// The picker reports an alias like `last30days`. The app turns that into a SINCE.
export function metricCardQuery(range) {
  const since = SINCE_BY_RANGE[range];
  return (metric) =>
    [
      'FROM sales',
      `SHOW ${metric}`,
      'TIMESERIES day WITH TOTALS, PERCENT_CHANGE',
      `SINCE ${since} UNTIL today`,
      'COMPARE TO previous_period',
      `VISUALIZE ${metric} TYPE line`,
    ].join(' ');
}
// [END campaign-dashboard.metric-card]

// [START campaign-dashboard.annotations-overlay]
// What the marks are now against what's on the store.
export function annotationOverlay({
  campaign,
  annotations,
  appId,
  dayOf,
  shortDate,
}) {
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
  const annotationDays = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Keyed on the formatted day, because Polaris Viz matches the axis label it drew and
  // holds one annotation per key. The pill fits the mark's name and the tooltip the title.
  const chartLabel = (title) => clamp(title.replace(/ (?:for|on) .+$/, ''), 24);
  const chartAnnotations = annotationDays.map(([day, list]) => ({
    startKey: shortDate(day),
    label: list.length > 1 ? `${list.length} annotations` : chartLabel(list[0].title),
    content: {
      // Portaled into a `foreignObject`. Plain HTML only.
      content: (
        <Fragment>
          {list.map((annotation) => (
            <div key={annotation.id}>{annotation.description ?? annotation.title}</div>
          ))}
        </Fragment>
      ),
      title: list.length > 1 ? shortDate(day) : list[0].title,
    },
    axis: 'x',
    color: annotationColor(list[0], appId),
  }));

  return {
    marks,
    ours,
    others,
    chartAnnotations,
    openCampaign: ours.find((annotation) => !annotation.endedAt) ?? null,
    // Read off the record. The annotations query is windowed and would miss a duplicate.
    incidentFlagged: Object.keys(campaign.markers ?? {}).some((key) =>
      key.startsWith('incident:'),
    ),
    legend: categoryLegend(annotations, appId),
  };
}
// [END campaign-dashboard.annotations-overlay]

// [START campaign-dashboard.card-render]
// Three numbers the app doesn't calculate. Wait for the ShopifyQL API, or the
// cards mount into an error state they never leave.
export function StoreTotals({statusLine, cardReady, range, setRange, cardQuery}) {
  return (
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
      <div style={{marginTop: '12px', marginBottom: '20px'}}>{statusLine}</div>
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
  );
}
// [END campaign-dashboard.card-render]

export function SalesAndOrders({
  campaign,
  totalSales,
  percentChange,
  isClient,
  sends,
  salesSeries,
  ordersSeries,
  chartAnnotations,
  legend,
  marks,
  ours,
  running,
  markNote,
  exploreHref,
  busy,
  submit,
  currency,
  percent,
}) {
  return (
    <s-section>
      <PanelHeader
        title={`Store sales during ${campaign.title}`}
        uses={{
          shopifyql:
            'One row per day for sales and orders, with the previous period beside it.',
          annotations:
            "The marks on the chart, read back from the store's own annotations.",
        }}
      />
      {/* The percentage is Shopify's, from COMPARE TO previous_period. */}
      <div style={{marginTop: '12px', marginBottom: '32px'}}>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text color="subdued">Total sales:</s-text>
          <s-heading>{currency(totalSales)}</s-heading>
          {percentChange !== null && (
            <s-badge
              tone={percentChange >= 0 ? 'success' : 'critical'}
              icon={percentChange >= 0 ? 'arrow-up' : 'arrow-down'}
            >
              {percent(percentChange)}
            </s-badge>
          )}
        </s-stack>
      </div>

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

      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base">
          {legend.map((entry) => (
            <s-stack
              key={entry.label}
              direction="inline"
              gap="small-500"
              alignItems="center"
            >
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
        {running && (
          <Fragment>
            {markNote && <s-text color="subdued">{markNote}</s-text>}
            <s-stack direction="inline">
              <s-button loading={busy} onClick={() => submit('rewrite-marks')}>
                {ours.length > 0 ? 'Rewrite' : 'Write'} the {marks.length} annotations
                on this chart
              </s-button>
            </s-stack>
          </Fragment>
        )}

        <s-link href={exploreHref} target="_blank">
          Open this report in the store&rsquo;s analytics dashboard
        </s-link>
        {/* [END campaign-dashboard.rewrite-render] */}
      </s-stack>
    </s-section>
  );
}

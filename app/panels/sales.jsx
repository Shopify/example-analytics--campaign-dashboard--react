import {Fragment, useEffect, useState} from 'react';

import {campaignMarks, campaignWindow} from '../campaigns';

import {PanelHeader} from './shared';

const SINCE_BY_RANGE = {
  today: 'today',
  last7days: 'startOfDay(-7d)',
  last30days: 'startOfDay(-30d)',
  last90days: 'startOfDay(-90d)',
  last365days: 'startOfDay(-365d)',
};

// [START campaign-dashboard.metric-card-ready]
// A metric card needs `window.shopify.shopifyQL`, installed after load. A card that
// mounts before it lands stays in an error state.
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

// [START campaign-dashboard.metric-card]
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

// [START campaign-dashboard.sales-card]
// Shopify runs the query and draws the result. VISUALIZE sets a TYPE per
// metric, ANNOTATE ALL overlays every annotation on the store, and COMPARE TO
// TARGETS measures the results against the store's configured targets.
export function salesCardQuery(campaign) {
  return [
    'FROM sales',
    'SHOW total_sales, orders',
    'TIMESERIES day',
    campaignWindow(campaign),
    'COMPARE TO TARGETS',
    'VISUALIZE total_sales TYPE bar, orders TYPE line ANNOTATE ALL',
  ].join(' ');
}
// [END campaign-dashboard.sales-card]

// [START campaign-dashboard.annotation-status]
// The marks this campaign should have, matched against what the store actually holds.
export function annotationStatus({campaign, annotations, appId}) {
  const marks = campaignMarks(campaign);

  // Only the app's annotations count toward the rewrite. It can't update or
  // delete another app's.
  const ours = annotations.filter(
    (annotation) => annotation.createdByApp?.id === appId,
  );

  // Base marks recorded on this campaign that the current marks no longer cover. Another
  // campaign's marks, milestones, and incidents stay out of the count.
  const current = new Set(marks.map((mark) => mark.key));
  const present = new Set(ours.map((annotation) => annotation.id));
  const outdated = Object.entries(campaign.markers ?? {}).filter(
    ([key, id]) =>
      !current.has(key) &&
      !key.startsWith('milestone:') &&
      !key.startsWith('incident:') &&
      present.has(id),
  ).length;

  return {
    marks,
    ours,
    outdated,
    // Marker IDs on the record pick this campaign's span out of the app's annotations.
    openCampaign:
      ours.find(
        (annotation) =>
          !annotation.endedAt &&
          Object.values(campaign.markers ?? {}).includes(annotation.id),
      ) ?? null,
    // Read off the record. The annotations query is windowed and would miss a duplicate.
    incidentFlagged: Object.keys(campaign.markers ?? {}).some((key) =>
      key.startsWith('incident:'),
    ),
  };
}
// [END campaign-dashboard.annotation-status]

// [START campaign-dashboard.card-render]
export function StoreTotals({statusLine, cardReady, range, setRange, cardQuery}) {
  return (
    <s-section>
      <PanelHeader
        title="Store totals"
        uses={{
          components:
            'Shopify metric cards, each running the query it displays.',
          shopifyql:
            "Each card's query, including the VISUALIZE clause.",
        }}
      />
      <div style={{marginBottom: '20px'}}>{statusLine}</div>
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
  rows,
  cell,
  shortDate,
  sends = new Map(),
  marks,
  ours,
  running,
  markNote,
  exploreHref,
  busy,
  submit,
  rewrote,
  currency,
  percent,
}) {
  const cardReady = useMetricCardsReady();
  const showSends = [...sends.values()].some((value) => value > 0);

  return (
    <s-section>
      <PanelHeader
        title={`Store sales during ${campaign.title}`}
        uses={{
          shopifyql:
            'One row per day for sales and orders, with the previous period beside it.',
          annotations:
            'ANNOTATE ALL draws every store annotation on the chart.',
        }}
      />
      {/* The percentage is Shopify's, from COMPARE TO previous_period. */}
      <div style={{marginBottom: '32px'}}>
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

      {/* [START campaign-dashboard.sales-card-render] */}
      {/* The card fills its container's height. Without one, the chart collapses
          to its minimum. */}
      <div style={{height: '320px', marginBottom: '16px'}}>
        {cardReady ? (
          <s-shopifyql-metric-card
            heading="Sales and orders by day"
            query={salesCardQuery(campaign)}
          />
        ) : (
          <s-spinner accessibilityLabel="Loading the sales chart" />
        )}
      </div>
      {/* [END campaign-dashboard.sales-card-render] */}

      {/* [START campaign-dashboard.sales-table-render] */}
      {/* The rows render as the query returned them. `cell` reads the generated columns. */}
      <details>
        <summary>Daily breakdown</summary>
        <s-box paddingBlockStart="base">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Day</s-table-header>
              {showSends && (
                <s-table-header listSlot="labeled">Messages sent</s-table-header>
              )}
              <s-table-header listSlot="labeled">Orders</s-table-header>
              <s-table-header listSlot="labeled">Sales</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={String(cell(row, 'day'))}>
                  <s-table-cell>{shortDate(cell(row, 'day'))}</s-table-cell>
                  {showSends && (
                    <s-table-cell>{sends.get(String(cell(row, 'day'))) ?? 0}</s-table-cell>
                  )}
                  <s-table-cell>{Number(cell(row, 'orders') ?? 0)}</s-table-cell>
                  <s-table-cell>{currency(cell(row, 'total_sales'))}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-box>
      </details>
      {/* [END campaign-dashboard.sales-table-render] */}

      <s-stack direction="block" gap="base">
        {/* [START campaign-dashboard.rewrite-render] */}
        {/* Replacing what the app already wrote, or the store's timeline accumulates
            every version of the story. */}
        {running && (
          <Fragment>
            {rewrote != null && (
              <s-banner tone="success" heading="Annotations rewritten">
                <s-paragraph>
                  The app replaced earlier annotations with {rewrote} current
                  ones.
                </s-paragraph>
              </s-banner>
            )}
            {markNote && <s-text color="subdued">{markNote}</s-text>}
            <s-text color="subdued">
              Rewriting replaces this app's earlier annotations with the current{' '}
              {marks.length}.
            </s-text>
            <s-stack direction="inline">
              <s-button
                loading={busy === 'rewrite-marks'}
                disabled={Boolean(busy)}
                onClick={() => submit('rewrite-marks')}
              >
                {ours.length > 0 ? 'Rewrite annotations' : 'Write annotations'}
              </s-button>
            </s-stack>
          </Fragment>
        )}

        <s-link href={exploreHref} target="_blank">
          Open in Analytics
        </s-link>
        {/* [END campaign-dashboard.rewrite-render] */}
      </s-stack>
    </s-section>
  );
}

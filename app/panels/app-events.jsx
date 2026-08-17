import {Fragment} from 'react';
import {ComboChart, FunnelChartNext, PolarisVizProvider} from '@shopify/polaris-viz';

import {CHANNEL_KEYS, CHANNELS} from '../channels';
import {withinWindow} from '../campaigns';

import {PanelHeader} from './shared';

// [START campaign-dashboard.funnel-totals]
// One row per day. A campaign total is a column summed rather than a value read.
export function funnelTotals(funnel, cell) {
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

  return {total, rate, sent, reached, bounced, unsubscribed, health};
}
// [END campaign-dashboard.funnel-totals]

// [START campaign-dashboard.reach-stats]
export function reachRowsFor(campaign, total) {
  const channelTotal = (key, slot) => total(CHANNELS[key].metrics[slot]);

  // What the campaign cost the list, per channel. Read off the rows rather than through
  // a metric card, which resolves columns against a catalog of published metrics that
  // App Events columns aren't in.
  return campaign.channels
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
}
// [END campaign-dashboard.reach-stats]

// [START campaign-dashboard.channel-funnels]
// One funnel per channel. Push has no delivery stage, and comparing its middle to
// email's would compare a send to a delivery.
export function channelFunnels(campaign, total) {
  return campaign.channels
    .map((key) => ({
      key,
      label: CHANNELS[key].label,
      stages: CHANNELS[key].stages.map((stage) => [stage.label, total(stage.metric)]),
    }))
    .filter((entry) => entry.stages[0][1] > 0);
}
// [END campaign-dashboard.channel-funnels]

// [START campaign-dashboard.sends-by-day]
// An app_events metric put on the sales axis. Keyed off the sales rows, not the
// event rows, so a day this app sent nothing still plots as a zero.
export function sendSeries({funnel, rows, cell, shortDate}) {
  const sendsByDay = new Map(
    (funnel.tableData.rows ?? []).map((row) => [cell(row, 'day'), row]),
  );
  const daily = (metric) =>
    rows.map((row) => ({
      key: shortDate(cell(row, 'day')),
      value: Number(cell(sendsByDay.get(cell(row, 'day')) ?? {}, metric) ?? 0),
    }));

  return [
    {name: 'Emails', data: daily('emails_sent')},
    {name: 'Texts', data: daily('sms_messages_sent')},
    {name: 'Pushes', data: daily('push_notifications_sent')},
  ].filter((series) => series.data.some((point) => point.value > 0));
}
// [END campaign-dashboard.sends-by-day]

// [START campaign-dashboard.sequence-charts]
// One chart per channel, keyed on the day each send went out. Nine sends on one
// chart reads a channel change as a rate change, because an open rate and a click
// rate don't measure the same act.
export function sequenceInsights({
  sequence,
  campaign,
  chartAnnotations,
  bounces,
  cell,
  shortDate,
  humanize,
}) {
  const sequenceCharts = CHANNEL_KEYS.map((key) => {
    const touches = sequence
      .filter((touch) => touch.channel === key)
      .map((touch) => ({
        ...touch,
        axis: shortDate(withinWindow(campaign, touch.day)),
      }));
    if (touches.length === 0) return null;

    return {
      channel: key,
      label: CHANNELS[key].label,
      reached: [
        {
          name: 'Reached',
          data: touches.map((touch) => ({key: touch.axis, value: touch.reached})),
        },
      ],
      rate: [
        {
          name: 'Engagement',
          data: touches.map((touch) => ({
            key: touch.axis,
            value: Math.round(touch.rate),
          })),
        },
      ],
      // Only the marks dated to this channel's send days. Polaris Viz keys an
      // annotation to a label it drew, and the other days aren't on this axis.
      annotations: chartAnnotations.filter((annotation) =>
        touches.some((touch) => touch.axis === annotation.startKey),
      ),
    };
  }).filter(Boolean);


  const bounceReasons = (bounces.tableData.rows ?? [])
    .filter((row) => Number(cell(row, 'emails_bounced')) > 0)
    .map((row) => ({
      reason: humanize(cell(row, 'recipient_status') ?? 'unrecorded'),
      count: Number(cell(row, 'emails_bounced')),
    }));

  return {sequenceCharts, bounceReasons};
}
// [END campaign-dashboard.sequence-charts]

// [START campaign-dashboard.send-events-render]
// The only panel that writes to App Events. Ingestion isn't immediate.
// Gated on the count, not on the row count. A campaign with no events still
// answers with one row of zeros.
export function SendEventsPanel({
  sent,
  funnel,
  sendCount,
  eventTotal,
  sentEvents,
  integer,
  busy,
  submit,
}) {
  if (sent !== 0) return null;

  return (
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
            Replay this campaign's sends as App Events. Its {sendCount} sends produce{' '}
            {eventTotal} events at one request each. Expect a minute or two.
          </s-paragraph>
          <s-paragraph>
            Shopify accepts an event before it ingests it. The funnels stay empty for a
            few minutes after this finishes. Reload the page then.
          </s-paragraph>
          {typeof sentEvents === 'number' && (
            <s-banner tone="success">
              <s-paragraph>
                {integer(sentEvents)} events accepted. Reload in a few minutes to see
                the funnels.
              </s-paragraph>
            </s-banner>
          )}
          <s-button loading={busy} onClick={() => submit('send-events')}>
            Send the campaign's events
          </s-button>
        </Fragment>
      )}
    </s-section>
  );
}
// [END campaign-dashboard.send-events-render]

// [START campaign-dashboard.funnel-render]
// One funnel per channel. One chart would compare a send to a delivery.
export function ChannelMetrics({funnels, integer}) {
  if (funnels.length === 0) return null;

  return (
    <s-section>
      <PanelHeader
        title="Channel metrics"
        uses={{
          appEvents:
            'Sends, deliveries, and engagement, from the events this app published.',
          shopifyql: "Buckets those events by day across the campaign's own window.",
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
                        data: entry.stages.map(([key, value]) => ({key, value})),
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
  );
}
// [END campaign-dashboard.funnel-render]

// [START campaign-dashboard.app-events-render]
// Reach falls because lists shrink. Engagement tracks the offer.
export function SendPerformance({sequence, sequenceCharts, isClient, integer}) {
  if (sequence.length === 0) return null;

  return (
    <s-section>
      <PanelHeader
        title="Send performance"
        uses={{
          appEvents: 'One event stream per send, published by this app at send time.',
          shopifyql:
            "Groups those events by send so each one's reach stands on its own.",
          annotations:
            "The campaign's own marks, drawn on the day each send went out.",
        }}
      />
      {isClient && (
        <s-query-container>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(280px, 1fr))" gap="base">
            {sequenceCharts.map((chart) => (
              <s-grid-item key={chart.channel}>
                <s-heading>{chart.label}</s-heading>
                <div className="chart-tooltip-fix" style={{height: '220px'}}>
                  <PolarisVizProvider>
                    <ComboChart
                      data={[
                        {
                          shape: 'Bar',
                          // No `name`. A named group draws a rotated axis title the
                          // legend already carries, and three narrow charts have no
                          // room for one.
                          yAxisOptions: {integersOnly: true},
                          series: chart.reached,
                        },
                        {
                          shape: 'Line',
                          yAxisOptions: {
                            labelFormatter: (value) => `${Math.round(value)}%`,
                          },
                          series: chart.rate,
                        },
                      ]}
                      annotations={chart.annotations}
                      theme="Light"
                    />
                  </PolarisVizProvider>
                </div>
              </s-grid-item>
            ))}
          </s-grid>
        </s-query-container>
      )}

      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Message</s-table-header>
          <s-table-header listSlot="secondary">Channel</s-table-header>
          <s-table-header listSlot="labeled">Sent</s-table-header>
          <s-table-header listSlot="labeled">Reached</s-table-header>
          <s-table-header listSlot="labeled">Engagement</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {sequence.map((touch) => (
            <s-table-row key={touch.template}>
              <s-table-cell>
                {touch.position}. {touch.name}
              </s-table-cell>
              <s-table-cell>{CHANNELS[touch.channel].label}</s-table-cell>
              <s-table-cell>{integer(touch.sent)}</s-table-cell>
              <s-table-cell>
                {/* Push has no delivery receipt. Repeating the sent count here would
                    read as a perfect delivery rate. */}
                {CHANNELS[touch.channel].metrics.reached ===
                CHANNELS[touch.channel].metrics.sent
                  ? 'Not reported'
                  : integer(touch.reached)}
              </s-table-cell>
              <s-table-cell>
                {integer(touch.engaged)} {touch.action} · {Math.round(touch.rate)}%
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}
// [END campaign-dashboard.app-events-render]

// [START campaign-dashboard.reach-render]
// A campaign can earn money and still cost the store contacts.
export function Deliverability({
  sent,
  health,
  reachRows,
  unsubscribed,
  rate,
  integer,
}) {
  if (sent === 0) return null;

  const listResult =
    unsubscribed === 0
      ? 'Nobody left the list.'
      : `Unsubscribes took ${integer(unsubscribed)} contacts off the list.`;

  return (
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
        {health.reach.toFixed(1)}% of {integer(sent)} sends arrived. {listResult}
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
  );
}
// [END campaign-dashboard.reach-render]

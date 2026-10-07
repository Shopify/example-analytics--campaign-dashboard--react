import {Fragment} from 'react';

import {CHANNELS} from '../channels';

import {ConfirmButton} from './confirm';
import {PanelHeader} from './shared';

// [START campaign-dashboard.funnel-totals]
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

  return campaign.channels
    .map((key) => {
      const metrics = CHANNELS[key].metrics;
      return {
        key,
        label: CHANNELS[key].label,
        sent: channelTotal(key, 'sent'),
        reached: channelTotal(key, 'reached'),
        bounced: metrics.bounced ? channelTotal(key, 'bounced') : null,
        unsubscribed: metrics.lost ? channelTotal(key, 'lost') : null,
      };
    })
    .filter((row) => row.sent > 0);
}
// [END campaign-dashboard.reach-stats]

// [START campaign-dashboard.channel-funnels]
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
// One total per day, for the Messages sent column beside sales and orders.
export function sendsByDay(funnel, cell) {
  return new Map(
    (funnel.tableData.rows ?? []).map((row) => [
      String(cell(row, 'day')),
      Number(cell(row, 'emails_sent') ?? 0) +
        Number(cell(row, 'sms_messages_sent') ?? 0) +
        Number(cell(row, 'push_notifications_sent') ?? 0),
    ]),
  );
}
// [END campaign-dashboard.sends-by-day]

// [START campaign-dashboard.bounce-reasons]
// The bounce query groups by recipient_status. Each row names one failure.
export function bounceReasons({bounces, cell, humanize}) {
  return (bounces.tableData.rows ?? [])
    .filter((row) => Number(cell(row, 'emails_bounced')) > 0)
    .map((row) => ({
      reason: humanize(cell(row, 'recipient_status') ?? 'unrecorded'),
      count: Number(cell(row, 'emails_bounced')),
    }));
}
// [END campaign-dashboard.bounce-reasons]

// [START campaign-dashboard.send-events-render]
// The only panel that writes to App Events.
export function SendEventsPanel({
  running,
  alreadySent,
  blocked,
  funnel,
  sendCount,
  eventTotal,
  busy,
  submit,
}) {
  // The record is the gate. A partial send closes it too, because idempotency keys
  // expire after 24 hours and a later resend would count every received event twice.
  if (alreadySent || !running) return null;

  // An undeclared column fails on `parseErrors` while the request itself succeeds.
  // Before the declaration propagates, that's the only signal App Events is unready.
  const unavailable =
    funnel.unavailable ??
    (funnel.parseErrors?.length ? funnel.parseErrors.join(' ') : null);

  return (
    <s-section>
      <PanelHeader
        title="Campaign events"
        uses={{
          appEvents:
            'The events this app published as the campaign ran, queryable like any schema.',
        }}
      />
      {unavailable ? (
        <s-banner tone="info" heading="Campaign events aren't available yet">
          {/* The event declarations define the columns. Without them, every column is missing. */}
          <s-paragraph>
            {/Column Not Found/i.test(unavailable)
              ? "The store doesn't have this app's event declarations. App Events needs early access. With access, deploy the app, then reload the page a few minutes later."
              : `Reload the page to try again. The store returned: ${unavailable}`}
          </s-paragraph>
        </s-banner>
      ) : (
        <Fragment>
          <s-paragraph>
            Send events to replay {sendCount} sends as {eventTotal} App Events.
            Sending takes a minute or two.
          </s-paragraph>
          <s-paragraph>
            Channel metrics appear a few minutes after sending. Reload the page to
            see them.
          </s-paragraph>
          <ConfirmButton
            id="send-events-modal"
            label="Send events"
            heading="Send this campaign's events?"
            body={`Shopify keeps all ${eventTotal} events, and no endpoint deletes them. The campaign can send only once.`}
            confirmLabel="Send events"
            loading={busy === 'send-events'}
            disabled={Boolean(busy || blocked)}
            onConfirm={() => submit('send-events')}
          />
          {blocked && <s-paragraph color="subdued">{blocked}</s-paragraph>}
        </Fragment>
      )}
    </s-section>
  );
}
// [END campaign-dashboard.send-events-render]

// [START campaign-dashboard.funnel-render]
export function ChannelMetrics({funnels, integer}) {
  if (funnels.length === 0) return null;

  return (
    <s-section>
      <PanelHeader
        title="Channel metrics"
        uses={{
          appEvents:
            'Sends, deliveries, and engagement, from the events this app published.',
          shopifyql: "Buckets the events by day across the campaign's window.",
        }}
      />
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Channel</s-table-header>
          <s-table-header listSlot="secondary">Stage</s-table-header>
          <s-table-header listSlot="labeled">Events</s-table-header>
          <s-table-header listSlot="labeled">% of sent</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {funnels.flatMap((entry) =>
            entry.stages.map(([label, value]) => (
              <s-table-row key={`${entry.key}-${label}`}>
                <s-table-cell>{entry.label}</s-table-cell>
                <s-table-cell>{label}</s-table-cell>
                <s-table-cell>{integer(value)}</s-table-cell>
                <s-table-cell>
                  {Math.round((value / entry.stages[0][1]) * 100)}%
                </s-table-cell>
              </s-table-row>
            )),
          )}
        </s-table-body>
      </s-table>
    </s-section>
  );
}
// [END campaign-dashboard.funnel-render]

// [START campaign-dashboard.app-events-render]
// Reach falls because lists shrink. Engagement tracks the offer.
export function SendPerformance({sequence, integer}) {
  if (sequence.length === 0) return null;

  return (
    <s-section>
      <PanelHeader
        title="Send performance"
        uses={{
          appEvents: 'One event stream per send, published by this app at send time.',
          shopifyql:
            'Groups the events by send and reports the reach of each send.',
        }}
      />
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
                {integer(touch.engaged)} {touch.action}, {Math.round(touch.rate)}%
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
      ? 'No unsubscribes.'
      : `${integer(unsubscribed)} ${unsubscribed === 1 ? 'unsubscribe' : 'unsubscribes'}.`;

  return (
    <s-section>
      <PanelHeader
        title="Deliverability"
        uses={{
          appEvents:
            'Bounces and unsubscribes, from the events this app published per send.',
          shopifyql: 'Filters the events to this campaign and totals them by send.',
        }}
      />
      <s-paragraph>
        {health.reach.toFixed(1)}% of {integer(sent)} messages were delivered. Push
        notifications count as sent, because push reports no delivery. {listResult}
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
                  : `${integer(row.bounced)}, ${rate(row.bounced, row.sent).toFixed(1)}% of sent`}
              </s-table-cell>
              <s-table-cell>
                {row.unsubscribed === null
                  ? 'Not reported'
                  : `${integer(row.unsubscribed)}, ${rate(row.unsubscribed, row.reached).toFixed(1)}% of reached`}
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}
// [END campaign-dashboard.reach-render]

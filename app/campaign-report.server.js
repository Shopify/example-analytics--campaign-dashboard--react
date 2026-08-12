import {SEQUENCE} from './app-events.server';
import {CHANNELS} from './channels';
import {BOUNCE_ALERT_RATE, clamp} from './campaigns';

// A daily timeseries has one row per day. A campaign total is the sum of a column.
export const sumColumn = (table, metric) =>
  (table.tableData?.rows ?? []).reduce(
    (total, row) => total + Number(row[metric] ?? 0),
    0,
  );

// [START campaign-dashboard.sequence-read]
// Join what the sequence sent to what the shop reported, one row per touch.
export function readSequence(table) {
  const byTemplate = new Map(
    (table.tableData?.rows ?? []).map((row) => [Number(row['template_id']), row]),
  );

  return SEQUENCE.map((touch, index) => {
    const row = byTemplate.get(touch.template);
    if (!row) return null;

    const metrics = CHANNELS[touch.channel].metrics;
    const sent = Number(row[metrics.sent] ?? 0);
    // A channel this campaign didn't run on. A zero bar reads as a failed send.
    if (sent === 0) return null;

    const reached = Number(row[metrics.reached] ?? 0);
    const engaged = Number(row[metrics.engaged] ?? 0);

    return {
      ...touch,
      position: index + 1,
      sent,
      reached,
      engaged,
      lost: metrics.lost ? Number(row[metrics.lost] ?? 0) : 0,
      // Scored against what was reached, not sent. Bounces don't count against it.
      rate: reached > 0 ? (engaged / reached) * 100 : 0,
      action: CHANNELS[touch.channel].action,
    };
  }).filter(Boolean);
}
// [END campaign-dashboard.sequence-read]

// [START campaign-dashboard.outcome-text]
// What a closed campaign leaves behind on the store's timeline.
export function outcomeText({campaign, revenue, target, sequence, money}) {
  const goal = Number(target ?? 0);
  const percent = goal > 0 ? Math.round((revenue / goal) * 100) : null;

  const title =
    percent === null
      ? `${campaign.title}: ${money(revenue)} earned`
      : `${campaign.title}: ${percent}% of target`;

  const sentences = [
    goal > 0
      ? `Earned ${money(revenue)} against a ${money(goal)} target`
      : `Earned ${money(revenue)}`,
  ];

  // How far the list moved between the first touch and the last.
  const first = sequence.at(0);
  const last = sequence.at(-1);
  if (first && last !== first) {
    sentences.push(
      `Engagement ${last.rate < first.rate ? 'fell' : 'rose'} from ${Math.round(
        first.rate,
      )}% to ${Math.round(last.rate)}% over ${sequence.length} touches`,
    );
  }

  // Titles cap at 75 characters, descriptions at 150.
  return {
    title: clamp(title, 75),
    description: clamp(`${sentences.join('. ')}.`, 150),
  };
}
// [END campaign-dashboard.outcome-text]

// [START campaign-dashboard.detect-incident]
// Names the kind of bounce, not only that one happened.
export function detectIncident(campaign, funnel, bounces) {
  const sent = sumColumn(funnel, 'emails_sent');
  const bounced = sumColumn(funnel, 'emails_bounced');
  if (sent === 0 || bounced / sent < BOUNCE_ALERT_RATE) return null;

  const rate = (bounced / sent) * 100;
  const reasons = (bounces.tableData?.rows ?? [])
    .filter((row) => Number(row['emails_bounced']) > 0)
    .map(
      (row) =>
        `${row['emails_bounced']} ${String(
          row['recipient_status'] ?? 'unrecorded',
        ).replace(/_/g, ' ')}`,
    )
    .join(', ');

  return {
    rate,
    title: clamp(`Deliverability drop on the ${campaign.title} email`, 75),
    description: clamp(
      `${bounced} of ${sent} emails bounced at ${rate.toFixed(1)}%${
        reasons ? `: ${reasons}` : ''
      }.`,
      150,
    ),
  };
}
// [END campaign-dashboard.detect-incident]

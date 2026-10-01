import {SEQUENCE} from './app-events.server';
import {CHANNELS} from './channels';
import {clamp} from './campaigns';

// [START campaign-dashboard.sequence-read]
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
      rate: reached > 0 ? (engaged / reached) * 100 : 0,
      action: CHANNELS[touch.channel].action,
    };
  }).filter(Boolean);
}
// [END campaign-dashboard.sequence-read]

// [START campaign-dashboard.outcome-text]
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

  // The strongest send, named with its channel. First against last would compare an
  // email open rate to an SMS click rate and report the channel as the change.
  const best = sequence.reduce(
    (top, touch) => (!top || touch.rate > top.rate ? touch : top),
    null,
  );
  if (best && sequence.length > 1) {
    sentences.push(
      `Top send: ${best.name} on ${
        CHANNELS[best.channel].label
      }, ${Math.round(best.rate)}% engagement`,
    );
  }

  return {
    title: clamp(title, 75),
    description: clamp(`${sentences.join('. ')}.`, 150),
  };
}
// [END campaign-dashboard.outcome-text]

// [START campaign-dashboard.detect-incident]
export const sumColumn = (table, metric) =>
  (table.tableData?.rows ?? []).reduce(
    (total, row) => total + Number(row[metric] ?? 0),
    0,
  );

export function detectIncident(campaign, funnel, bounces) {
  const sent = sumColumn(funnel, 'emails_sent');
  const bounced = sumColumn(funnel, 'emails_bounced');
  if (sent === 0 || bounced === 0) return null;

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
    title: clamp(`${campaign.title} email bounces`, 75),
    description: clamp(
      `${bounced} of ${sent} emails bounced, ${rate.toFixed(1)}%.${
        reasons ? ` Reasons: ${reasons}.` : ''
      }`,
      150,
    ),
  };
}
// [END campaign-dashboard.detect-incident]

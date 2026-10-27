import {CHANNELS} from './channels';
import {clamp} from './campaigns';

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

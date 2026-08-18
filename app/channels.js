// [START campaign-dashboard.channel-registry]
// What each channel can report, from the standard event registry. No metric name
// matches the handle that produces it.
export const CHANNELS = {
  email: {
    label: 'Email',
    stages: [
      {label: 'Sent', metric: 'emails_sent'},
      {label: 'Delivered', metric: 'emails_delivered'},
      {label: 'Opened', metric: 'emails_opened'},
      {label: 'Clicked', metric: 'email_clicks'},
    ],
    metrics: {
      sent: 'emails_sent',
      reached: 'emails_delivered',
      engaged: 'emails_opened',
      // A bounce never arrived. An unsubscribe arrived and opted out.
      bounced: 'emails_bounced',
      lost: 'email_unsubscribes',
    },
    // What engagement means here. Three channels don't count the same act.
    action: 'opened',
  },
  sms: {
    label: 'SMS',
    stages: [
      {label: 'Sent', metric: 'sms_messages_sent'},
      {label: 'Delivered', metric: 'sms_messages_delivered'},
      {label: 'Clicked', metric: 'sms_clicks'},
    ],
    metrics: {
      sent: 'sms_messages_sent',
      reached: 'sms_messages_delivered',
      engaged: 'sms_clicks',
      lost: 'sms_unsubscribes',
    },
    action: 'clicked',
  },
  push: {
    label: 'Push',
    stages: [
      {label: 'Sent', metric: 'push_notifications_sent'},
      {label: 'Opened', metric: 'push_notifications_opened'},
    ],
    // Push has no delivery receipt. What it reached is what it sent.
    metrics: {
      sent: 'push_notifications_sent',
      reached: 'push_notifications_sent',
      engaged: 'push_notifications_opened',
    },
    action: 'opened',
  },
};

export const CHANNEL_KEYS = Object.keys(CHANNELS);

// Not funnel stages, but read from the same rows. A column left out reads as zero.
export const FUNNEL_METRICS = CHANNEL_KEYS.flatMap((key) => [
  ...CHANNELS[key].stages.map((stage) => stage.metric),
  CHANNELS[key].metrics.bounced,
  CHANNELS[key].metrics.lost,
]).filter((metric, index, all) => metric && all.indexOf(metric) === index);

// The four metrics that score a send.
const SCORED = ['sent', 'reached', 'engaged', 'lost'];

export const SEQUENCE_METRICS = CHANNEL_KEYS.flatMap((key) =>
  SCORED.map((slot) => CHANNELS[key].metrics[slot]),
).filter((metric, index, all) => metric && all.indexOf(metric) === index);
// [END campaign-dashboard.channel-registry]

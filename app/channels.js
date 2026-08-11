// [START campaign-dashboard.channel-registry]
// What each channel can report, taken from the standard event registry. The stages
// are different lengths because the registry gives push no delivery receipt and no
// unsubscribe, and no metric name matches the handle that produces it.
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
    // What engagement means here, so one axis can't imply three channels count the
    // same act.
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
    // Push has no delivery receipt, so what it reached is what it sent.
    metrics: {
      sent: 'push_notifications_sent',
      reached: 'push_notifications_sent',
      engaged: 'push_notifications_opened',
    },
    action: 'opened',
  },
};

export const CHANNEL_KEYS = Object.keys(CHANNELS);

// List growth runs ahead of every send, so it isn't a channel.
export const LIST_STAGES = [
  {label: 'Submitted', metric: 'forms_submitted'},
  {label: 'Captured', metric: 'leads_captured'},
  {label: 'Incentivized', metric: 'incentives_issued'},
];

// Losses aren't funnel stages, but the health panel and the bounce alert read the
// same rows the funnel is drawn from, so a column left out here reads as a permanent
// zero rather than as an error.
export const FUNNEL_METRICS = [
  ...LIST_STAGES.map((stage) => stage.metric),
  ...CHANNEL_KEYS.flatMap((key) => [
    ...CHANNELS[key].stages.map((stage) => stage.metric),
    CHANNELS[key].metrics.bounced,
    CHANNELS[key].metrics.lost,
  ]),
].filter((metric, index, all) => metric && all.indexOf(metric) === index);

// Grouping by template_id scores each touch, so the sequence needs these four
// metrics rather than every stage.
const SCORED = ['sent', 'reached', 'engaged', 'lost'];

export const SEQUENCE_METRICS = CHANNEL_KEYS.flatMap((key) =>
  SCORED.map((slot) => CHANNELS[key].metrics[slot]),
).filter((metric, index, all) => metric && all.indexOf(metric) === index);
// [END campaign-dashboard.channel-registry]

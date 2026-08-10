// [START campaign-dashboard.channel-registry]
// What each channel can report, taken from the standard event registry. The
// stages are deliberately different lengths: email carries four and push carries
// two, because the registry gives push no delivery receipt and no unsubscribe.
// Reporting a stage a channel doesn't have would mean inventing the number.
//
// None of these metric names match the handle that produces them. `email_sent`
// counts into `emails_sent` and `push_opened` into `push_notifications_opened`,
// so read each one off the registry rather than deriving it.
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
      lost: 'email_unsubscribes',
    },
    // What engagement means here, so one axis can't imply three channels count
    // the same act.
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

// The list-growth funnel runs ahead of every send, so it isn't a channel. It
// measures whether the list grew rather than whether a message landed.
export const LIST_STAGES = [
  {label: 'Submitted', metric: 'forms_submitted'},
  {label: 'Captured', metric: 'leads_captured'},
  {label: 'Incentivized', metric: 'incentives_issued'},
];

// Every metric the funnel query has to ask for, which is every declared event
// across the channels plus the list-growth ones.
export const FUNNEL_METRICS = [
  ...LIST_STAGES.map((stage) => stage.metric),
  ...CHANNEL_KEYS.flatMap((key) => [
    ...CHANNELS[key].stages.map((stage) => stage.metric),
    CHANNELS[key].metrics.lost,
  ]),
].filter((metric, index, all) => metric && all.indexOf(metric) === index);

// The sequence query groups by template_id, so it only needs the four metrics a
// touch is scored on rather than every stage.
export const SEQUENCE_METRICS = CHANNEL_KEYS.flatMap((key) =>
  Object.values(CHANNELS[key].metrics),
).filter((metric, index, all) => metric && all.indexOf(metric) === index);
// [END campaign-dashboard.channel-registry]

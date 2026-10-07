import {shopMorning} from './campaigns';

// [START campaign-dashboard.app-events-token]
let cached = {token: null, expiresAt: 0};

async function getAppEventsToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const response = await fetch('https://api.shopify.com/auth/access_token', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const {access_token: token, expires_in: expiresIn} = await response.json();
  // Tokens last 60 minutes. Refresh a minute early.
  cached = {token, expiresAt: Date.now() + ((expiresIn ?? 3600) - 60) * 1000};
  return token;
}
// [END campaign-dashboard.app-events-token]

// [START campaign-dashboard.app-events-shared]
const FLOW_ID = 5501;

function marketing(channel, template, extra = {}) {
  return {
    channel,
    message_type: 'campaign',
    flow_id: FLOW_ID,
    template_id: template,
    consent_state: 'opted_in',
    ...extra,
  };
}
// [END campaign-dashboard.app-events-shared]

// [START campaign-dashboard.app-events-funnel]
// Nine sends over two weeks. Engagement dips on repeats and recovers when the
// offer changes.
export const SEQUENCE = [
  {day: 0, channel: 'email', template: 4101, name: 'Announcement', audience: 52, engaged: 0.42, clicked: 0.28, lost: 1},
  {day: 1, channel: 'sms', template: 4102, name: 'Early access', audience: 21, engaged: 0.34, lost: 0},
  {day: 3, channel: 'email', template: 4103, name: 'Non-openers', audience: 33, engaged: 0.24, clicked: 0.22, lost: 3},
  {day: 5, channel: 'push', template: 4104, name: 'App exclusive', audience: 26, engaged: 0.38},
  {day: 7, channel: 'email', template: 4105, name: 'Bestsellers', audience: 51, engaged: 0.31, clicked: 0.3, lost: 2},
  {day: 8, channel: 'sms', template: 4106, name: 'BOGO offer', audience: 20, engaged: 0.41, lost: 1},
  {day: 11, channel: 'push', template: 4107, name: 'Influencer drop', audience: 25, engaged: 0.45},
  {day: 12, channel: 'email', template: 4108, name: 'Last chance', audience: 49, engaged: 0.36, clicked: 0.25, lost: 2},
  {day: 13, channel: 'sms', template: 4109, name: 'Final hours', audience: 19, engaged: 0.37, lost: 2},
];

// What each channel can report. Push has two stages where email has six, because the
// registry gives it no delivery receipt and no click.
const CHANNELS = {
  email: {
    delivery: 0.94,
    steps: {
      sent: {handle: 'shopify.marketing.email_sent', code: 'snt', hour: 0},
      delivered: {
        handle: 'shopify.marketing.email_delivered',
        code: 'dlv',
        hour: 1,
        extra: {recipient_status: 'delivered'},
      },
      bounced: {
        handle: 'shopify.marketing.email_bounced',
        code: 'bnc',
        hour: 1,
        extra: (index) => ({
          recipient_status: index % 3 === 0 ? 'hard_bounce' : 'soft_bounce',
        }),
      },
      engaged: {handle: 'shopify.marketing.email_opened', code: 'opn', hour: 14},
      clicked: {
        handle: 'shopify.marketing.email_clicked',
        code: 'clk',
        hour: 16,
        extra: {link_domain: 'shop.example.com'},
      },
      lost: {
        handle: 'shopify.marketing.email_unsubscribed',
        code: 'uns',
        hour: 18,
        extra: {recipient_status: 'unsubscribed'},
      },
    },
  },
  sms: {
    delivery: 0.97,
    steps: {
      sent: {
        handle: 'shopify.marketing.sms_sent',
        code: 'snt',
        hour: 0,
        extra: {country_code: 'US'},
      },
      delivered: {
        handle: 'shopify.marketing.sms_delivered',
        code: 'dlv',
        hour: 1,
        extra: {country_code: 'US', recipient_status: 'delivered'},
      },
      engaged: {
        handle: 'shopify.marketing.sms_clicked',
        code: 'clk',
        hour: 4,
        extra: {country_code: 'US', link_domain: 'shop.example.com'},
      },
      lost: {
        handle: 'shopify.marketing.sms_unsubscribed',
        code: 'uns',
        hour: 6,
        extra: {country_code: 'US', recipient_status: 'unsubscribed'},
      },
    },
  },
  push: {
    steps: {
      sent: {
        handle: 'shopify.marketing.push_sent',
        code: 'snt',
        hour: 0,
        extra: (index) => ({
          device_platform: index % 2 === 0 ? 'ios' : 'android',
        }),
      },
      engaged: {
        handle: 'shopify.marketing.push_opened',
        code: 'opn',
        hour: 2,
        extra: (index) => ({
          device_platform: index % 2 === 0 ? 'ios' : 'android',
        }),
      },
    },
  },
};

// Leave out what the channel can't report.
function expand(touch) {
  const channel = CHANNELS[touch.channel];
  const delivered = channel.delivery
    ? Math.round(touch.audience * channel.delivery)
    : touch.audience;
  const engaged = Math.round(delivered * touch.engaged);

  const counts = {
    sent: touch.audience,
    delivered,
    bounced: touch.audience - delivered,
    engaged,
    clicked: Math.round(engaged * (touch.clicked ?? 0)),
    lost: touch.lost ?? 0,
  };

  return Object.entries(counts).flatMap(([name, count]) => {
    const step = channel.steps[name];
    if (!step || count < 1) return [];
    return {
      handle: step.handle,
      channel: touch.channel,
      code: `d${touch.day}${step.code}`,
      count,
      day: touch.day,
      hour: step.hour,
      attributes: (index) =>
        marketing(
          touch.channel,
          touch.template,
          typeof step.extra === 'function' ? step.extra(index) : step.extra,
        ),
    };
  });
}

const STAGES = SEQUENCE.flatMap(expand);

// Every timestamp is an offset from the campaign's start date. Shopify keeps every
// event it accepts, and one dated ahead of today falls outside the funnel's window.
const LAST_OFFSET = Math.max(
  ...STAGES.map((stage) => stage.day * 86400000 + stage.hour * 3600000),
);

export const funnelWindowEnd = (startDate, timeZone) =>
  shopMorning(startDate, timeZone) + LAST_OFFSET;

// [START campaign-dashboard.send-window]
// The schedule runs two weeks from the start date. A campaign that ends sooner would
// date sends after it closed, and the App Events API can't retract a submitted event.
export const funnelFitsWindow = (startDate, endDate, timeZone) =>
  funnelWindowEnd(startDate, timeZone) <= shopMorning(endDate, timeZone) + 86400000;

// Why an active campaign can't send yet, or null. The page disables the button
// with this reason, and the action checks it again.
export function sendBlocker(campaign, timeZone, locale, now = Date.now()) {
  if (!funnelFitsWindow(campaign.startDate, campaign.endDate, timeZone)) {
    return 'The send schedule runs 14 days, and this campaign is shorter. Send events from a campaign that runs at least 14 days.';
  }
  // The replay dates its events across the two weeks after the start date. A campaign
  // still mid-schedule would stamp the remainder ahead of today.
  const lastSend = funnelWindowEnd(campaign.startDate, timeZone);
  if (lastSend > now) {
    const day = new Intl.DateTimeFormat(locale, {month: 'short', day: 'numeric', timeZone}).format(lastSend);
    return `Available from ${day}, when the 14-day send schedule ends.`;
  }
  return null;
}
// [END campaign-dashboard.send-window]

// No endpoint deletes an event. A channel the campaign didn't select would add numbers
// to a funnel the app never renders.
const selected = (channels) =>
  STAGES.filter((stage) => (channels ?? []).includes(stage.channel));

// Derived from `SEQUENCE`. A change to the send plan updates this count with it.
export const eventTotal = (channels) =>
  selected(channels).reduce((total, stage) => total + stage.count, 0);

// One send fans out into as many events as its channel reports.
export const sendCount = (channels) =>
  SEQUENCE.filter((touch) => (channels ?? []).includes(touch.channel)).length;

// Bump this to reseed inside the 24-hour idempotency window.
const RUN = 'r3';

// A minute between recipients. The largest send finishes inside the hour it started.
function stageTimestamp(start, day, hour, index) {
  const offset = day * 86400000 + hour * 3600000 + index * 60000;
  return new Date(start + offset).toISOString();
}
// [END campaign-dashboard.app-events-funnel]

// [START campaign-dashboard.app-events-send]
async function sendEvent({token, shopId, stage, campaignId, start, index}) {
  // A network failure counts as one failed event. Throwing would lose the received count.
  try {
    return await postEvent({token, shopId, stage, campaignId, start, index});
  } catch (error) {
    return {ok: false, status: 'network', body: error.message};
  }
}

async function postEvent({token, shopId, stage, campaignId, start, index}) {
  const response = await fetch('https://api.shopify.com/app/2027-01/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      shop_id: shopId,
      // Must match the shopify.extension.toml declaration exactly.
      event_handle: stage.handle,
      timestamp: stageTimestamp(start, stage.day, stage.hour, index),
      idempotency_key: `${shopId.split('/').pop()}-${campaignId}-${RUN}-${stage.code}-${index}`,
      // `campaign_id` is the join, the one dimension both categories accept.
      attributes: {campaign_id: campaignId, ...stage.attributes(index)},
    }),
  });

  if (response.status === 202) return {ok: true};
  return {ok: false, status: response.status, body: await response.text()};
}

export async function sendCampaignFunnel({
  shopId,
  campaignId,
  startDate,
  timeZone,
  channels,
}) {
  const token = await getAppEventsToken();
  const start = shopMorning(startDate, timeZone);
  const accepted = {};
  const failures = [];

  // A real send would work off a queue.
  for (const stage of selected(channels)) {
    const results = await Promise.all(
      Array.from({length: stage.count}, (_unused, index) =>
        sendEvent({token, shopId, stage, campaignId, start, index}),
      ),
    );
    // Several sends share one handle. This accumulates.
    accepted[stage.handle] =
      (accepted[stage.handle] ?? 0) + results.filter((r) => r.ok).length;
    const failed = results.find((result) => !result.ok);
    if (failed) failures.push(`${stage.handle}: ${failed.status} ${failed.body}`);
  }

  return {accepted, failures};
}
// [END campaign-dashboard.app-events-send]

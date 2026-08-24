import {
  METAFIELDS_SET,
  STATE_KEY,
  STATE_NAMESPACE,
  STATE_QUERY,
} from './campaign-queries.server';

// [START campaign-dashboard.campaign-store]
// Every query, target, and annotation on the dashboard derives from these fields.
// Stored in one app-data metafield. A real app would use a database.
export const CAMPAIGN_FIELDS = {
  id: 'Integer the App Events attribute is typed as. Filters every event query.',
  title: 'What the user typed. Ends up in every annotation title.',
  startDate: 'YYYY-MM-DD. The SINCE of every query on the page.',
  endDate: 'YYYY-MM-DD. The UNTIL of every query on the page.',
  channels: 'Subset of email, sms, push. Decides which funnels render.',
  products: 'GID and title for each promoted product, from the resource picker.',
  audience: 'Tier value written onto each targeted customer at launch.',
  members:
    'Customer ID and display name per tier member, saved at launch. Redaction removes them.',
  creatorCodes:
    'Discount code and the creator who hands it out, for each code made by hand in the admin.',
  revenueTarget: 'Store-wide sales target, as a decimal string.',
  productTarget: 'Sales target filtered to the promoted products.',
  audienceTarget: 'Sales target filtered to the targeted tier.',
  status:
    'planned, running, closed, or canceled. Decides which actions are offered.',
  markers: 'Annotation IDs the app wrote, keyed by mark. What a rewrite addresses.',
  targets:
    "Target IDs the app created. Targets aren't app-scoped. Deleting only these keeps a cancel off the user's own targets.",
};

// IDs stay spent. Event data can't be deleted, and a reused ID inherits its funnel.
export const FIRST_CAMPAIGN_ID = 4210;

export const emptyState = () => ({campaigns: []});

export const nextCampaignId = (campaigns) =>
  campaigns.reduce(
    (highest, campaign) => Math.max(highest, Number(campaign.id)),
    FIRST_CAMPAIGN_ID - 1,
  ) + 1;
// [END campaign-dashboard.campaign-store]

// [START campaign-dashboard.campaign-read]
// A throttled or rejected request answers with `errors` and a null `data`. There are no
// nested `userErrors` to find, which is what makes an unchecked call read as a clean one.
export const transportErrors = (body) =>
  (body.errors ?? []).map((error) => ({message: error.message}));

// Returns this app's ID alongside the records. The namespace derives from it.
export async function readCampaigns(admin) {
  const body = await (await admin.graphql(STATE_QUERY)).json();
  const installation = body.data?.currentAppInstallation;
  const stored = installation?.metafield?.value;

  let state = emptyState();
  if (stored) {
    try {
      state = JSON.parse(stored);
    } catch {
      // A hand-edited metafield shouldn't take the app down. Start over.
      state = emptyState();
    }
  }

  return {
    // An empty list from a failed read is indistinguishable from a store with no
    // campaigns. Every write below refuses on a failed read.
    failed: transportErrors(body),
    appId: installation?.app?.id ?? null,
    // The value `app_name` holds in App Events, which every app writes to.
    appName: installation?.app?.title ?? null,
    installationId: installation?.id ?? null,
    campaigns: state.campaigns ?? [],
  };
}

export const findCampaign = (campaigns, campaignId) =>
  campaigns.find((campaign) => String(campaign.id) === String(campaignId)) ??
  null;
// [END campaign-dashboard.campaign-read]

// [START campaign-dashboard.campaign-write]
// metafieldsSet overwrites the whole value. `json` holds 128 KB, a few hundred records.
async function writeState(admin, installationId, state) {
  const response = await admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId: installationId,
          namespace: STATE_NAMESPACE,
          key: STATE_KEY,
          type: 'json',
          value: JSON.stringify(state),
        },
      ],
    },
  });
  const body = await response.json();
  const failed = transportErrors(body);
  if (failed.length) return failed;
  return body.data?.metafieldsSet?.userErrors ?? [];
}

// Read, change the one record, write the list back.
export async function updateCampaign(admin, campaignId, change) {
  const {installationId, campaigns, failed} = await readCampaigns(admin);
  // The write replaces the whole value. Writing what a failed read returned would
  // erase every record the store has.
  if (failed.length) return {campaign: null, userErrors: failed};

  const updated = campaigns.map((campaign) =>
    String(campaign.id) === String(campaignId)
      ? {...campaign, ...change}
      : campaign,
  );
  const userErrors = await writeState(admin, installationId, {
    campaigns: updated,
  });
  return {campaign: findCampaign(updated, campaignId), userErrors};
}

// Annotation IDs per mark, to find and rewrite an annotation after the campaign runs.
export async function rememberMarkers(admin, campaignId, markers) {
  const {campaigns} = await readCampaigns(admin);
  const campaign = findCampaign(campaigns, campaignId);
  return updateCampaign(admin, campaignId, {
    markers: {...campaign?.markers, ...markers},
  });
}
// [END campaign-dashboard.campaign-write]

// The roster is the only customer data this app stores. The tier metafield
// goes with the customer. This is what's left.
export async function forgetCustomer(admin, customerId) {
  const {installationId, campaigns, failed} = await readCampaigns(admin);
  if (failed.length) return failed;

  const without = campaigns.map((campaign) => ({
    ...campaign,
    members: (campaign.members ?? []).filter(
      (member) => member.id !== customerId,
    ),
  }));
  return writeState(admin, installationId, {campaigns: without});
}

// [START campaign-dashboard.seed-campaign]
// Both start planned. One starts mid-flight, the other weeks out.
function seedRecords() {
  const day = (date) => date.toISOString().slice(0, 10);
  const shift = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return day(date);
  };

  return [
    {
      id: FIRST_CAMPAIGN_ID,
      title: 'Summer launch',
      // Dated 20 days in with a week left. Launch it and the nine sends land over the
      // first two weeks, leaving room for the sales they moved.
      startDate: shift(-20),
      endDate: shift(7),
      channels: ['email', 'sms', 'push'],
      products: [],
      audience: 'vip',
      // Two belong to one creator, the pairing no built-in dimension holds.
      creatorCodes: [
        {code: 'AVERY10', creator: 'Avery'},
        {code: 'AVERYSUMMER', creator: 'Avery'},
        {code: 'JUNO15', creator: 'Juno'},
      ],
      revenueTarget: '10000.00',
      productTarget: '4000.00',
      audienceTarget: '5000.00',
      status: 'planned',
      markers: {},
      targets: {},
    },
    // Starting in the future. Every panel on its page is the setup it still needs.
    {
      id: FIRST_CAMPAIGN_ID + 1,
      title: 'Back to school',
      startDate: shift(14),
      endDate: shift(35),
      channels: ['email', 'sms'],
      products: [],
      audience: 'regulars',
      creatorCodes: [],
      revenueTarget: '8000.00',
      productTarget: '3000.00',
      audienceTarget: '4000.00',
      status: 'planned',
      markers: {},
      targets: {},
    },
  ];
}

export async function ensureCampaign(admin) {
  const state = await readCampaigns(admin);
  // Seeding on a failed read would overwrite the campaigns already stored.
  if (state.failed.length) return {...state, userErrors: state.failed};
  if (state.campaigns.length > 0) return {...state, userErrors: []};

  const campaigns = seedRecords();
  // A failed seed write leaves nothing to show. Return the reason.
  const userErrors = await writeState(admin, state.installationId, {campaigns});
  if (userErrors.length > 0) return {...state, campaigns: [], userErrors};
  return {...state, campaigns, userErrors: []};
}
// [END campaign-dashboard.seed-campaign]

// [START campaign-dashboard.spawn-campaign]
// Every App Events filter keys on the ID. It has to be an integer, and it has to be new.
export async function createCampaign(admin, fields) {
  const {installationId, campaigns, failed} = await readCampaigns(admin);
  // `nextCampaignId` counts from what it read. A failed read hands out an ID that
  // already has App Events data behind it.
  if (failed.length) return {campaign: null, userErrors: failed};

  const campaign = {
    id: nextCampaignId(campaigns),
    title: fields.title,
    startDate: fields.startDate,
    endDate: fields.endDate,
    channels: fields.channels,
    products: fields.products ?? [],
    audience: fields.audience ?? 'everyone',
    creatorCodes: fields.creatorCodes ?? [],
    revenueTarget: fields.revenueTarget,
    productTarget: fields.productTarget,
    audienceTarget: fields.audienceTarget,
    status: 'planned',
    markers: {},
    targets: {},
  };

  const userErrors = await writeState(admin, installationId, {
    campaigns: [...campaigns, campaign],
  });
  return {campaign, userErrors};
}
// [END campaign-dashboard.spawn-campaign]

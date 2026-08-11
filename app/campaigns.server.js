import {
  METAFIELDS_SET,
  STATE_KEY,
  STATE_NAMESPACE,
  STATE_QUERY,
} from './campaign-queries.server';

// [START campaign-dashboard.campaign-store]
// Every query, target, and annotation on the dashboard is derived from these fields,
// which is what keeps a second campaign from needing a second codebase. The store is one
// app-data metafield rather than a table. A real app would use its own storage.
export const CAMPAIGN_FIELDS = {
  id: 'Integer the App Events attribute is typed as, so it can filter events.',
  title: 'What the user typed. Ends up in every annotation title.',
  startDate: 'YYYY-MM-DD. The SINCE of every query on the page.',
  endDate: 'YYYY-MM-DD. The UNTIL of every query on the page.',
  channels: 'Subset of email, sms, push. Decides which funnels render.',
  products: 'GID and title for each promoted product, from the resource picker.',
  audience: 'Tier value written onto each targeted customer at launch.',
  revenueTarget: 'Store-wide sales goal, as a decimal string.',
  productTarget: 'Sales goal filtered to the promoted products.',
  audienceTarget: 'Sales goal filtered to the targeted tier.',
  status:
    'planned, running, closed, or canceled. Decides which actions are offered.',
  markers: 'Annotation IDs the app wrote, keyed by mark, so it can update them.',
  targets:
    "Target IDs the app created. Targets aren't app-scoped, so deleting only these is what keeps a cancel off the user's own goals.",
};

// A canceled campaign keeps its record and its ID stays spent, because event data can't
// be deleted and a reused ID would inherit the canceled campaign's funnel.
export const FIRST_CAMPAIGN_ID = 4210;

export const emptyState = () => ({campaigns: []});

export const nextCampaignId = (campaigns) =>
  campaigns.reduce(
    (highest, campaign) => Math.max(highest, Number(campaign.id)),
    FIRST_CAMPAIGN_ID - 1,
  ) + 1;
// [END campaign-dashboard.campaign-store]

// [START campaign-dashboard.campaign-read]
// One read returns the app's own ID alongside the records, because the app-owned
// metafield namespace is built from it and annotation ownership compares against it.
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
    appId: installation?.app?.id ?? null,
    installationId: installation?.id ?? null,
    campaigns: state.campaigns ?? [],
  };
}

export const findCampaign = (campaigns, campaignId) =>
  campaigns.find((campaign) => String(campaign.id) === String(campaignId)) ??
  null;
// [END campaign-dashboard.campaign-read]

// [START campaign-dashboard.campaign-write]
// metafieldsSet overwrites the whole value, so a write sends the whole list. The `json`
// type holds up to 128 KB, which is a few hundred campaigns.
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
  return body.data?.metafieldsSet?.userErrors ?? [];
}

// Read, change the one record, write the list back. Every action on the detail page
// goes through this, so a change to the shape lands in one place.
export async function updateCampaign(admin, campaignId, change) {
  const {installationId, campaigns} = await readCampaigns(admin);
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

// Annotation IDs are stored per mark so a marker written before the campaign ran
// can be found and rewritten afterwards.
export async function rememberMarkers(admin, campaignId, markers) {
  const {campaigns} = await readCampaigns(admin);
  const campaign = findCampaign(campaigns, campaignId);
  return updateCampaign(admin, campaignId, {
    markers: {...(campaign?.markers ?? {}), ...markers},
  });
}
// [END campaign-dashboard.campaign-write]

// [START campaign-dashboard.seed-campaign]
// The first load seeds one campaign over the last two weeks. The window is relative to
// today, so the queries return whatever the development store has actually sold.
function seedRecord() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 13);
  const day = (date) => date.toISOString().slice(0, 10);

  return {
    id: FIRST_CAMPAIGN_ID,
    title: 'Summer launch',
    startDate: day(start),
    endDate: day(end),
    channels: ['email', 'sms', 'push'],
    products: [],
    audience: 'vip',
    revenueTarget: '5000.00',
    productTarget: '2000.00',
    audienceTarget: '2500.00',
    status: 'planned',
    markers: {},
    targets: {},
  };
}

export async function ensureCampaign(admin) {
  const state = await readCampaigns(admin);
  if (state.campaigns.length > 0) return {...state, userErrors: []};

  const campaign = seedRecord();
  // A failed seed write leaves nothing to show, so return the reason rather than a
  // campaign the store doesn't have.
  const userErrors = await writeState(admin, state.installationId, {
    campaigns: [campaign],
  });
  if (userErrors.length > 0) return {...state, campaigns: [], userErrors};
  return {...state, campaigns: [campaign], userErrors: []};
}
// [END campaign-dashboard.seed-campaign]

// [START campaign-dashboard.spawn-campaign]
// The ID is what every App Events attribute filter and every campaign comparison keys
// on, so it has to be an integer and it has to be new.
export async function createCampaign(admin, fields) {
  const {installationId, campaigns} = await readCampaigns(admin);

  const campaign = {
    id: nextCampaignId(campaigns),
    title: fields.title,
    startDate: fields.startDate,
    endDate: fields.endDate,
    channels: fields.channels,
    products: fields.products ?? [],
    audience: fields.audience ?? 'everyone',
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

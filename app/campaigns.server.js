import {
  METAFIELDS_SET,
  STATE_KEY,
  STATE_NAMESPACE,
  STATE_QUERY,
} from './campaign-queries.server';

// [START campaign-dashboard.campaign-store]
// A campaign is a record the app owns: a name, a window, the channels it sends
// on, the products it promotes, the audience it targets, and the goals it was
// given. Every query, target, and annotation on the dashboard is derived from
// these fields, which is what keeps a second campaign from needing a second
// codebase.
//
// The store is one app-data metafield rather than a table, so the tutorial has no
// database of its own to set up. A real app would use its own storage. The shape
// is what matters.
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
  status: 'planned, running, or closed. Decides which actions are offered.',
  markers: 'Annotation IDs the app wrote, keyed by mark, so it can update them.',
};

// A canceled campaign keeps its record with `status: 'canceled'` rather than
// disappearing. Its ID stays spent, because event data can't be deleted and a
// reused ID would inherit the canceled campaign's funnel.
export const FIRST_CAMPAIGN_ID = 4210;

export const emptyState = () => ({campaigns: []});

export const nextCampaignId = (campaigns) =>
  campaigns.reduce(
    (highest, campaign) => Math.max(highest, Number(campaign.id)),
    FIRST_CAMPAIGN_ID - 1,
  ) + 1;
// [END campaign-dashboard.campaign-store]

// [START campaign-dashboard.campaign-read]
// One read returns the app's own ID alongside the records, because almost
// everything else on the page needs it: the app-owned metafield namespace is
// built from it, and telling this app's annotations from another app's is a
// comparison against it.
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
// metafieldsSet overwrites the whole value, so a write sends the whole list. The
// json type holds up to 128 KB, which is a few hundred campaigns.
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

// Read, change the one record, write the list back. Every action on the detail
// page goes through this, so a change to the shape lands in one place.
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

export async function forgetMarker(admin, campaignId, key) {
  const {campaigns} = await readCampaigns(admin);
  const markers = {...(findCampaign(campaigns, campaignId)?.markers ?? {})};
  delete markers[key];
  return updateCampaign(admin, campaignId, {markers});
}
// [END campaign-dashboard.campaign-write]

// [START campaign-dashboard.seed-campaign]
// A dashboard with nothing on it can't be checked against the store's analytics,
// so the first load seeds one campaign over the last two weeks. Its window is
// relative to today, which means the queries return whatever the development
// store has actually sold rather than nothing at all.
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
  };
}

export async function ensureCampaign(admin) {
  const state = await readCampaigns(admin);
  if (state.campaigns.length > 0) return state;

  const campaign = seedRecord();
  await writeState(admin, state.installationId, {campaigns: [campaign]});
  return {...state, campaigns: [campaign]};
}
// [END campaign-dashboard.seed-campaign]

// [START campaign-dashboard.spawn-campaign]
// The second campaign is what proves the dashboard reads a record rather than a
// constant. Its ID is what every App Events attribute filter and every campaign
// comparison keys on, so it has to be an integer and it has to be new.
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
  };

  const userErrors = await writeState(admin, installationId, {
    campaigns: [...campaigns, campaign],
  });
  return {campaign, userErrors};
}
// [END campaign-dashboard.spawn-campaign]

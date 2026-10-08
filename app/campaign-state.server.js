import db from './db.server';

// [START campaign-dashboard.campaign-state]
// The IDs of the annotations and targets this app created, and the App Events send count.
// They live in the app's database. The merchant can edit or clear the Campaign entry.
// Prisma drops an undefined filter. A missing shop would read or delete every shop's rows.
function ownShop(shop) {
  if (!shop) throw new TypeError('Campaign records need a shop.');
  return shop;
}

const key = (shop, campaignId) => ({shop_campaignId: {shop: ownShop(shop), campaignId: Number(campaignId)}});

const parsed = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

const stateOf = (row) => ({
  gid: row.campaignGid,
  markers: parsed(row.markers),
  targets: parsed(row.targets),
  sentEvents: row.sentEvents,
});

// A campaign created in the admin has no row, and no annotations or targets yet.
export const emptyState = () => ({markers: {}, targets: {}, sentEvents: null});

export async function readStates(shop, campaignIds) {
  const rows = await db.campaignState.findMany({
    where: {shop: ownShop(shop), campaignId: {in: campaignIds.map(Number)}},
  });
  return new Map(rows.map((row) => [row.campaignId, stateOf(row)]));
}

export async function readState(shop, campaignId) {
  const row = await db.campaignState.findUnique({where: key(shop, campaignId)});
  return row ? stateOf(row) : null;
}

// A row left by an entry the merchant deleted in the admin belongs to that entry. A new
// entry with the same campaign ID starts empty.
async function claimRow(client, shop, campaignId, gid) {
  const id = Number(campaignId);
  await client.campaignState.deleteMany({where: {shop: ownShop(shop), campaignId: id, campaignGid: {not: gid}}});
  return client.campaignState.upsert({
    where: key(shop, id),
    create: {shop, campaignId: id, campaignGid: gid},
    update: {},
  });
}

// Replaces each field the change names. Pass a markers or targets object.
export async function saveState(shop, campaignId, gid, {markers, targets}) {
  const data = {
    ...(markers && {markers: JSON.stringify(markers)}),
    ...(targets && {targets: JSON.stringify(targets)}),
  };
  return db.$transaction(async (tx) => {
    await claimRow(tx, shop, campaignId, gid);
    return stateOf(await tx.campaignState.update({where: key(shop, campaignId), data}));
  });
}

// Each annotation ID lands as its mark saves. Merge into the stored IDs, not the ones in hand.
export async function mergeMarkers(shop, campaignId, gid, patch) {
  return db.$transaction(async (tx) => {
    const row = await claimRow(tx, shop, campaignId, gid);
    const markers = {...parsed(row.markers), ...patch};
    await tx.campaignState.update({
      where: key(shop, campaignId),
      data: {markers: JSON.stringify(markers)},
    });
    return markers;
  });
}

// Zero marks a send in progress. Only the request that moves the count off null sends.
export async function claimSend(shop, campaignId, gid) {
  await claimRow(db, shop, campaignId, gid);
  const {count} = await db.campaignState.updateMany({
    where: {shop, campaignId: Number(campaignId), sentEvents: null},
    data: {sentEvents: 0},
  });
  return count === 1;
}

export const recordSend = async (shop, campaignId, sent) =>
  db.campaignState.update({where: key(shop, campaignId), data: {sentEvents: sent}});

// Nothing landed, so the campaign can send again.
export const releaseSend = async (shop, campaignId) =>
  db.campaignState.updateMany({
    where: {shop: ownShop(shop), campaignId: Number(campaignId), sentEvents: 0},
    data: {sentEvents: null},
  });

export const forgetCampaign = async (shop, campaignId) =>
  db.campaignState.deleteMany({where: {shop: ownShop(shop), campaignId: Number(campaignId)}});

// Everything the app holds for a shop, in one transaction.
export const forgetShop = async (shop) =>
  db.$transaction([
    db.session.deleteMany({where: {shop: ownShop(shop)}}),
    db.campaignLock.deleteMany({where: {shop}}),
    db.campaignState.deleteMany({where: {shop}}),
    db.shopState.deleteMany({where: {shop}}),
  ]);
// [END campaign-dashboard.campaign-state]

// [START campaign-dashboard.allocate-campaign-id]
// Raise the mark to `id` without ever lowering it.
export async function spendThrough(shop, id) {
  await db.shopState.upsert({where: {shop: ownShop(shop)}, create: {shop, lastCampaignId: id}, update: {}});
  await db.shopState.updateMany({
    where: {shop, lastCampaignId: {lt: id}},
    data: {lastCampaignId: id},
  });
}

// `floor` is the highest ID on the store's entries. It covers entries made before this
// row existed, or after a redact deleted it. The increment is atomic, and two requests
// never get the same ID.
export async function allocateCampaignId(shop, floor) {
  await spendThrough(shop, floor);
  const {lastCampaignId} = await db.shopState.update({
    where: {shop},
    data: {lastCampaignId: {increment: 1}},
  });
  return lastCampaignId;
}

export const hasSpentIds = async (shop) =>
  Boolean(await db.shopState.findUnique({where: {shop}}));
// [END campaign-dashboard.allocate-campaign-id]

// A request that dies holding the lock leaves its row. The next request takes over
// after five minutes.
const LOCK_TTL_MS = 5 * 60 * 1000;

// Returns the owner token, or null while another request holds the campaign.
export async function takeLock(shop, campaignId) {
  const id = Number(campaignId);
  const now = new Date();
  await db.campaignLock.deleteMany({where: {shop: ownShop(shop), campaignId: id, expiresAt: {lt: now}}});
  const owner = crypto.randomUUID();
  try {
    await db.campaignLock.create({
      data: {shop, campaignId: id, owner, expiresAt: new Date(now.getTime() + LOCK_TTL_MS)},
    });
    return owner;
  } catch (error) {
    // P2002 is a unique constraint failure. Another request holds the row.
    if (error?.code === 'P2002') return null;
    throw error;
  }
}

// Deletes only this request's row. A takeover after the TTL keeps the new owner's.
export const releaseLock = async (shop, campaignId, owner) =>
  db.campaignLock.deleteMany({where: {shop: ownShop(shop), campaignId: Number(campaignId), owner}});

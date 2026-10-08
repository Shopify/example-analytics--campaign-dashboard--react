import {describe, expect, it} from 'vitest';
import {
  allocateCampaignId,
  claimSend,
  forgetCampaign,
  forgetShop,
  hasSpentIds,
  mergeMarkers,
  readState,
  readStates,
  recordSend,
  releaseSend,
  saveState,
  spendThrough,
} from '../app/campaign-state.server';
import {SHOP, db, seedState, storedState, tablesOf} from './helpers/db';

const GID = 'gid://shopify/Metaobject/1';

describe('campaign IDs', () => {
  it('counts up from the floor and never hands out an ID twice', async () => {
    expect(await allocateCampaignId(SHOP, 4209)).toBe(4210);
    expect(await allocateCampaignId(SHOP, 4210)).toBe(4211);
    // Deleting the highest campaign lowers the floor. The spent ID stays spent.
    expect(await allocateCampaignId(SHOP, 4209)).toBe(4212);
  });

  it('jumps past an entry the database has no record of', async () => {
    await allocateCampaignId(SHOP, 4209);
    expect(await allocateCampaignId(SHOP, 4300)).toBe(4301);
  });

  it('gives parallel requests distinct IDs', async () => {
    const ids = await Promise.all([allocateCampaignId(SHOP, 4209), allocateCampaignId(SHOP, 4209)]);
    expect(ids.sort()).toEqual([4210, 4211]);
  });

  it('keeps each shop on its own count', async () => {
    await allocateCampaignId(SHOP, 4209);
    expect(await allocateCampaignId('other.test', 4209)).toBe(4210);
  });

  it('raises the spent mark without lowering it', async () => {
    expect(await hasSpentIds(SHOP)).toBe(false);
    await spendThrough(SHOP, 4211);
    await spendThrough(SHOP, 4210);
    expect(await hasSpentIds(SHOP)).toBe(true);
    expect(tablesOf().shopState).toEqual([{shop: SHOP, lastCampaignId: 4211}]);
  });
});

describe('campaign records', () => {
  it('reads a campaign without a row as missing', async () => {
    expect(await readState(SHOP, 4210)).toBeNull();
    expect((await readStates(SHOP, [4210])).size).toBe(0);
  });

  it('refuses to read without a shop', async () => {
    await expect(readStates(undefined, [4210])).rejects.toThrow(TypeError);
  });

  it('saves only the fields the change names', async () => {
    await saveState(SHOP, 4210, GID, {targets: {store: 't1'}});
    await saveState(SHOP, 4210, GID, {markers: {campaign: 'a1'}});
    expect(await readState(SHOP, 4210)).toEqual({
      gid: GID,
      markers: {campaign: 'a1'},
      targets: {store: 't1'},
      sentEvents: null,
    });
  });

  it('merges marker IDs into the stored ones', async () => {
    seedState({campaignId: 4210, markers: {campaign: 'a1'}});
    expect(await mergeMarkers(SHOP, 4210, GID, {launch: 'a2'})).toEqual({campaign: 'a1', launch: 'a2'});
    expect(storedState(4210).markers).toEqual({campaign: 'a1', launch: 'a2'});
  });

  it('starts a new entry with the same campaign ID empty', async () => {
    seedState({campaignId: 4210, gid: 'gid://shopify/Metaobject/old', markers: {campaign: 'a1'}, sentEvents: 9});
    await saveState(SHOP, 4210, GID, {targets: {store: 't1'}});
    expect(storedState(4210)).toEqual({campaignGid: GID, markers: {}, targets: {store: 't1'}, sentEvents: null});
  });

  it('deletes one campaign row', async () => {
    seedState({campaignId: 4210});
    seedState({campaignId: 4211});
    await forgetCampaign(SHOP, '4210');
    expect(tablesOf().campaignState.map((row) => row.campaignId)).toEqual([4211]);
  });
});

describe('sends', () => {
  it('lets one claim through', async () => {
    const claims = await Promise.all([claimSend(SHOP, 4210, GID), claimSend(SHOP, 4210, GID)]);
    expect(claims.sort()).toEqual([false, true]);
    await recordSend(SHOP, 4210, 9);
    expect(await claimSend(SHOP, 4210, GID)).toBe(false);
    expect(storedState(4210).sentEvents).toBe(9);
  });

  it('allows a new claim after a send that landed nothing', async () => {
    expect(await claimSend(SHOP, 4210, GID)).toBe(true);
    await releaseSend(SHOP, 4210);
    expect(await claimSend(SHOP, 4210, GID)).toBe(true);
  });

  it('keeps a recorded send when the release runs', async () => {
    seedState({campaignId: 4210, sentEvents: 9});
    await releaseSend(SHOP, 4210);
    expect(storedState(4210).sentEvents).toBe(9);
  });
});

describe('forgetShop', () => {
  it("deletes the shop's sessions, records, locks, and spent IDs and leaves other shops", async () => {
    for (const shop of [SHOP, 'other.test']) {
      await db.session.create({data: {id: `offline_${shop}`, shop}});
      await spendThrough(shop, 4211);
      seedState({campaignId: 4210, shop});
      await db.campaignLock.create({data: {shop, campaignId: 4210, owner: 'o', expiresAt: new Date()}});
    }
    await forgetShop(SHOP);
    for (const rows of Object.values(tablesOf())) {
      expect(rows.map((row) => row.shop)).toEqual(['other.test']);
    }
  });

  it('refuses without a shop', async () => {
    await expect(forgetShop(undefined)).rejects.toThrow(TypeError);
  });
});

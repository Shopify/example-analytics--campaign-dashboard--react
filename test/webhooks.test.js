import {describe, expect, it, vi} from 'vitest';
import {mockAdmin} from './helpers/admin';
import {SHOP, db, seedState, tablesOf} from './helpers/db';

const hook = {value: null};
vi.mock('../app/shopify.server', () => ({
  authenticate: {webhook: async () => hook.value},
}));
const {action} = await import('../app/routes/webhooks.customers.redact.jsx');

describe('customers/redact', () => {
  it('deletes the customer\'s tier metafield', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mock = mockAdmin({
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {deletedMetafields: [], userErrors: []}}}),
    });
    hook.value = {admin: mock.raw, shop: 'example.test', topic: 'CUSTOMERS_REDACT', payload: {customer: {id: 5}}};
    const response = await action({request: new Request('https://app.test/webhooks', {method: 'POST'})});
    expect(response.status).toBe(200);
    expect(mock.calls[0].variables.metafields[0].ownerId).toBe('gid://shopify/Customer/5');
  });

  it('answers 200 without a session', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    hook.value = {admin: undefined, shop: 'example.test', topic: 'CUSTOMERS_REDACT', payload: {customer: {id: 5}}};
    const response = await action({request: new Request('https://app.test/webhooks', {method: 'POST'})});
    expect(response.status).toBe(200);
  });
});

const dataRequest = await import('../app/routes/webhooks.customers.data_request.jsx');

describe('customers/data_request', () => {
  it('reports the tier the app wrote on the customer', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mock = mockAdmin({
      CustomerTier: () => ({data: {customer: {tier: {value: 'vip'}}}}),
    });
    hook.value = {admin: mock.raw, shop: 'example.test', topic: 'CUSTOMERS_DATA_REQUEST', payload: {customer: {id: 5}}};
    const response = await dataRequest.action({request: new Request('https://app.test/webhooks', {method: 'POST'})});
    expect(response.status).toBe(200);
    expect(log).toHaveBeenLastCalledWith('Customer 5 holds tier "vip" from this app');
    expect(mock.calls.map((call) => call.op)).toEqual(['CustomerTier']);
  });
});

const shopRedact = await import('../app/routes/webhooks.shop.redact.jsx');
const uninstalled = await import('../app/routes/webhooks.app.uninstalled.jsx');

describe('app lifecycle webhooks', () => {
  const seed = async () => {
    await db.session.create({data: {id: `offline_${SHOP}`, shop: SHOP}});
    await db.shopState.create({data: {shop: SHOP, lastCampaignId: 4211}});
    seedState({campaignId: 4210, markers: {campaign: 'a1'}});
  };
  const post = () => new Request('https://app.test/webhooks', {method: 'POST'});

  it("keeps the campaign records on uninstall and deletes the shop's sessions", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await seed();
    hook.value = {shop: SHOP, session: {id: `offline_${SHOP}`}, topic: 'APP_UNINSTALLED'};
    await uninstalled.action({request: post()});
    expect(tablesOf().session).toEqual([]);
    expect(tablesOf().shopState).toHaveLength(1);
    expect(tablesOf().campaignState).toHaveLength(1);
  });

  it("deletes every record the app holds for the shop on shop/redact", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await seed();
    hook.value = {shop: SHOP, topic: 'SHOP_REDACT'};
    const response = await shopRedact.action({request: post()});
    expect(response.status).toBe(200);
    for (const rows of Object.values(tablesOf())) expect(rows).toEqual([]);
  });
});

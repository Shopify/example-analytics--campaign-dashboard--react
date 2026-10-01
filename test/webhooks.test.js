import {describe, expect, it, vi} from 'vitest';
import {mockAdmin} from './helpers/admin';
import {listOf, node} from './helpers/campaign';

const hook = {value: null};
vi.mock('../app/shopify.server', () => ({
  authenticate: {webhook: async () => hook.value},
}));
const {action} = await import('../app/routes/webhooks.customers.redact.jsx');

describe('customers/redact', () => {
  it('removes the customer reference from the campaigns that hold it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mock = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210, members: ['gid://shopify/Customer/5', 'gid://shopify/Customer/6']})]),
      UpdateCampaign: () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: []}}}),
    });
    hook.value = {admin: mock.admin, shop: 'example.test', topic: 'CUSTOMERS_REDACT', payload: {customer: {id: 5}}};
    const response = await action({request: new Request('https://app.test/webhooks', {method: 'POST'})});
    expect(response.status).toBe(200);
    expect(mock.calls.at(-1).variables.metaobject.fields).toEqual([{key: 'members', value: '["gid://shopify/Customer/6"]'}]);
  });

  it('answers 200 without a session', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    hook.value = {admin: undefined, shop: 'example.test', topic: 'CUSTOMERS_REDACT', payload: {customer: {id: 5}}};
    const response = await action({request: new Request('https://app.test/webhooks', {method: 'POST'})});
    expect(response.status).toBe(200);
  });
});

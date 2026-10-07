import {describe, expect, it, vi} from 'vitest';
import {mockAdmin} from './helpers/admin';

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

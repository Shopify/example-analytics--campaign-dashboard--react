import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mockAdmin} from './helpers/admin';
import {MAX_THROTTLE_WAIT_MS, queryShopifyQL, shopifyqlErrors} from '../app/shopifyql.server';

const QUERY = 'query CampaignSales { shopifyqlQuery(query: "FROM sales SHOW total_sales") { tableData { rows } parseErrors } }';
const rows = {data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '10'}]}, parseErrors: []}}};
const throttled = (windowResetAt) => ({
  data: null,
  errors: [{message: 'Throttled', extensions: {code: 'THROTTLED'}}],
  extensions: windowResetAt ? {shopifyqlCost: {windowResetAt}} : undefined,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('queryShopifyQL', () => {
  it('waits until the budget refills, then retries once', async () => {
    const answers = [throttled('2026-10-07T12:00:03Z'), rows];
    const {admin, calls} = mockAdmin({CampaignSales: () => answers.shift()});
    const pending = queryShopifyQL(admin, QUERY);
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(rows);
    expect(calls).toHaveLength(2);
  });

  it('retries a 429 after a short wait, since its body is gone', async () => {
    const answers = [new Response(null, {status: 429}), rows];
    const {admin, calls} = mockAdmin({CampaignSales: () => answers.shift()});
    const pending = queryShopifyQL(admin, QUERY);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(rows);
    expect(calls).toHaveLength(2);
  });

  it('gives up when the budget refills past the cap', async () => {
    const resetAt = new Date(Date.now() + MAX_THROTTLE_WAIT_MS + 1000).toISOString();
    const {admin, calls} = mockAdmin({CampaignSales: () => throttled(resetAt)});
    const body = await queryShopifyQL(admin, QUERY);
    expect(calls).toHaveLength(1);
    expect(shopifyqlErrors(body)).toEqual([{message: "This store's ShopifyQL budget refills at 12:00:11 UTC. Try again then."}]);
  });

  it('returns a second throttle as it came back', async () => {
    const {admin, calls} = mockAdmin({CampaignSales: () => throttled('2026-10-07T12:00:01Z')});
    const pending = queryShopifyQL(admin, QUERY);
    await vi.advanceTimersByTimeAsync(1000);
    expect(shopifyqlErrors(await pending)).toEqual([{message: 'Throttled'}]);
    expect(calls).toHaveLength(2);
  });

  it("doesn't retry a parse error", async () => {
    const {admin, calls} = mockAdmin({
      CampaignSales: () => ({data: {shopifyqlQuery: {tableData: null, parseErrors: ['Bad metric']}}}),
    });
    expect(shopifyqlErrors(await queryShopifyQL(admin, QUERY))).toEqual([{message: 'Bad metric'}]);
    expect(calls).toHaveLength(1);
  });
});

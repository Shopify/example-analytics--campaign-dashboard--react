import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mockAdmin} from './helpers/admin';
import {base, planned, session} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {loader} = await import('../app/routes/app.campaigns._index.jsx');

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const STORE = 'gid://shopify/AnalyticsTarget/5';
// Every read without a handler here answers empty.
const overview = async (handlers) => {
  const entry = planned({status: 'running', targets: {store: STORE}});
  const all = {...base(entry), ...handlers};
  const mock = mockAdmin(
    new Proxy(all, {
      get: (target, op) =>
        target[op] ?? (() => ({data: {shopifyqlQuery: {tableData: {columns: [], rows: []}, parseErrors: []}}})),
    }),
  );
  session.admin = mock.raw;
  return loader({request: new Request('https://app.test/app/campaigns')});
};
const target = {id: STORE, expectedValue: '1000', shopifyqlQuery: 'FROM sales SHOW total_sales'};

describe('overview target progress', () => {
  it('reports a failed progress read and leaves the value unmeasured', async () => {
    const data = await overview({
      CampaignTargets: () => ({data: {targets: [target]}}),
      TargetProgress: () => ({data: null, errors: [{message: 'Internal error'}]}),
    });
    expect(data.targetsUnavailable).toBe('Internal error');
    expect(data.targets).toEqual([{id: STORE, campaignId: '4210', expected: 1000, actual: null}]);
  });

  it('reports a target read that threw', async () => {
    const data = await overview({
      CampaignTargets: () => {
        throw new Error('socket hang up');
      },
    });
    expect(data.targetsUnavailable).toMatch(/socket hang up/);
  });

  it('reports nothing when every read lands', async () => {
    const data = await overview({
      CampaignTargets: () => ({data: {targets: [target]}}),
      TargetProgress: () => ({data: {t0: {tableData: {rows: [{total_sales: '250'}]}, parseErrors: []}}}),
    });
    expect(data.targetsUnavailable).toBeNull();
    expect(data.targets[0].actual).toBe(250);
  });
});

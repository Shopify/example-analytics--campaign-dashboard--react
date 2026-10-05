import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mockAdmin, ops} from './helpers/admin';
import {base, planned, session} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {loader} = await import('../app/routes/app.campaigns.$campaignId.jsx');

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Every read without a handler here answers empty. The test checks which ones ran.
const load = async (entry) => {
  const handlers = base(entry);
  const mock = mockAdmin(
    new Proxy(handlers, {
      get: (target, op) =>
        target[op] ??
        (() => ({data: {shop: {currencyCode: 'USD', ianaTimezone: 'Etc/UTC'}, shopifyqlQuery: {tableData: {columns: [], rows: []}, parseErrors: []}}})),
    }),
  );
  session.admin = mock.raw;
  const data = await loader({request: new Request('https://app.test/app/campaigns/4210'), params: {campaignId: '4210'}});
  return {data, ran: ops(mock.calls)};
};

describe('campaign page loader', () => {
  it('runs top products on every campaign and skips the QR funnel without codes', async () => {
    const {data, ran} = await load(planned());
    expect(data.fatal).toBeNull();
    expect(ran).toContain('CampaignTopProducts');
    expect(ran).not.toContain('CampaignQRFunnel');
    expect(data.qrFunnel.tableData.rows).toEqual([]);
  });

  it('runs the QR funnel once the campaign has a code', async () => {
    const {data, ran} = await load(planned({qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]}));
    expect(data.fatal).toBeNull();
    expect(ran).toContain('CampaignQRFunnel');
    expect(ran).toContain('CampaignTopProducts');
  });
});

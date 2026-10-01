import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ops} from './helpers/admin';
import {base, lastUpdate, marking, planned, resetTargets, runWith, targeting} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {action: campaignAction} = await import('../app/routes/app.campaigns.$campaignId.jsx');
const run = runWith(campaignAction);

beforeEach(() => {
  resetTargets();
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('activate', () => {
  it('writes the annotations and creates no target without amounts', async () => {
    const {mock, result} = run({...base(planned()), ...marking}, {intent: 'activate'});
    expect(await result).toEqual({ok: true});
    expect(ops(mock.calls)).not.toContain('CreateCampaignTarget');
    expect(ops(mock.calls)).toContain('CreateCampaignAnnotation');
    expect(lastUpdate(mock.calls)).toMatchObject({status: 'running', targets: '{}', members: '[]'});
  });

  it('creates every target with an amount, one per QR code', async () => {
    const entry = planned({
      products: [{id: 'gid://shopify/Product/1', title: 'Hat'}],
      qrCodes: [
        {id: 'gid://shopify/Metaobject/901', handle: 'hat-front'},
        {id: 'gid://shopify/Metaobject/902', handle: 'hat-back', title: {value: 'Hat back'}, liveOn: {value: '2026-09-25'}},
      ],
      revenueTarget: '10000',
      productTarget: '4000',
      qrTarget: '500',
    });
    const {mock, result} = run(
      {
        ...base(entry),
        ...marking,
        ...targeting,
        PromotedProductKinds: () => ({data: {nodes: []}}),
        SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({ok: true});
    const filters = mock.calls.filter((call) => call.op === 'CreateCampaignTarget').map((call) => call.variables.input.filters ?? null);
    expect(filters).toEqual([null, 'product_id IN (1)', "utm_campaign = 'hat-front'", "utm_campaign = 'hat-back'"]);
    expect(Object.keys(JSON.parse(lastUpdate(mock.calls).targets))).toEqual(['store', 'product', 'qr:hat-front', 'qr:hat-back']);
    const marks = mock.calls.filter((call) => call.op === 'CreateCampaignAnnotation').map((call) => call.variables.input.title);
    expect(marks).toEqual(expect.arrayContaining(['hat-front QR code for Summer launch', 'Hat back QR code for Summer launch']));
    const qrTargets = mock.calls
      .filter((call) => call.op === 'CreateCampaignTarget' && call.variables.input.filters?.startsWith('utm_campaign'))
      .map(({variables: {input}}) => [input.name, input.startDate]);
    expect(qrTargets).toEqual([
      ['Summer launch: hat-front QR code', '2026-09-10'],
      ['Summer launch: Hat back QR code', '2026-09-25'],
    ]);
  });

  it('deletes the new targets when their IDs fail to save', async () => {
    let updates = 0;
    const {mock, result} = run(
      {
        ...base(planned({revenueTarget: '100'})),
        ...marking,
        ...targeting,
        UpdateCampaign: ({metaobject}) => {
          updates += 1;
          const failing = metaobject.fields.some((field) => field.key === 'targets');
          return {data: {metaobjectUpdate: {metaobject: null, userErrors: failing ? [{message: 'Too big'}] : []}}};
        },
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({problems: ['Too big']});
    expect(mock.calls.find((call) => call.op === 'DeleteCampaignTargets').variables.ids).toEqual(['gid://shopify/AnalyticsTarget/1']);
    expect(updates).toBeGreaterThan(0);
  });

  it('rejects a campaign that already runs', async () => {
    const {mock, result} = run({...base(planned({status: 'running'}))}, {intent: 'activate'});
    expect(await result).toEqual({problems: ['This campaign is already active.']});
    expect(ops(mock.calls)).not.toContain('CreateCampaignAnnotation');
  });
});

describe('set-targets', () => {
  it('clears a blank amount and keeps an absent one', async () => {
    const {mock, result} = run(base(planned({revenueTarget: '100', productTarget: '50'})), {
      intent: 'set-targets',
      revenueTarget: '',
      qrTarget: '25.50',
    });
    expect(await result).toEqual({ok: true});
    expect(lastUpdate(mock.calls)).toEqual({revenue_target: '', qr_target: '25.50'});
  });

  it.each(['0', '-5', 'abc', '1e3', '10.123'])('rejects %s', async (value) => {
    const {mock, result} = run(base(planned()), {intent: 'set-targets', revenueTarget: value});
    expect((await result).problems[0]).toMatch(/above zero/);
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });
});

describe('close', () => {
  const running = (overrides) =>
    planned({status: 'running', markers: {campaign: 'gid://shopify/AnalyticsAnnotation/9'}, ...overrides});
  const closing = (entry, targets, measured) => ({
    ...base(entry),
    CampaignFunnel: () => ({data: {shopifyqlQuery: {tableData: {columns: [], rows: []}, parseErrors: []}}}),
    CampaignSequence: () => ({data: {shopifyqlQuery: {tableData: {columns: [], rows: []}, parseErrors: []}}}),
    CampaignTargets: () => ({data: {targets}}),
    RaiseCampaignTarget: () => ({data: {analyticsTargetUpdate: {userErrors: []}}}),
    MeasureTarget: measured,
    CloseCampaignAnnotation: () => ({data: {analyticsAnnotationUpdate: {userErrors: []}}}),
  });

  it('measures the window sales without a target', async () => {
    const {mock, result} = run(
      closing(running(), [], () => ({data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '1234'}]}, parseErrors: []}}})),
      {intent: 'close'},
    );
    expect(await result).toMatchObject({ok: true});
    const query = mock.calls.find((call) => call.op === 'MeasureTarget');
    expect(query).toBeTruthy();
    const close = mock.calls.find((call) => call.op === 'CloseCampaignAnnotation').variables.input;
    expect(close.title).toBe('Summer launch: $1,234 earned');
    expect(lastUpdate(mock.calls)).toEqual({end_date: '2026-09-30', status: 'closed'});
  });

  it('refuses to close on an unmeasured read', async () => {
    const {mock, result} = run(
      closing(running(), [], () => ({data: {shopifyqlQuery: {parseErrors: ['bad']}}})),
      {intent: 'close'},
    );
    expect(await result).toEqual({problems: ["Couldn't measure sales. Reload and close the campaign again."]});
    expect(ops(mock.calls)).not.toContain('CloseCampaignAnnotation');
  });

  it('reports against the store target', async () => {
    const store = {id: 'gid://shopify/AnalyticsTarget/3', expectedValue: '2000', shopifyqlQuery: 'FROM sales SHOW total_sales'};
    const {mock, result} = run(
      closing(running({targets: {store: store.id}}), [store], () => ({
        data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '1000'}]}, parseErrors: []}},
      })),
      {intent: 'close'},
    );
    expect(await result).toMatchObject({ok: true});
    expect(mock.calls.find((call) => call.op === 'CloseCampaignAnnotation').variables.input.title).toBe('Summer launch: 50% of target');
  });

  it("ends each target on the close day, or on its start for a code that wasn't live", async () => {
    const store = {id: 'gid://shopify/AnalyticsTarget/3', startDate: '2026-09-10', expectedValue: '2000', shopifyqlQuery: 'FROM sales SHOW total_sales'};
    const later = {id: 'gid://shopify/AnalyticsTarget/4', startDate: '2026-10-03', expectedValue: '100', shopifyqlQuery: 'FROM campaign_sales SHOW x'};
    const {mock, result} = run(
      closing(running({targets: {store: store.id, 'qr:hat-back': later.id}}), [store, later], () => ({
        data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '1000'}]}, parseErrors: []}},
      })),
      {intent: 'close'},
    );
    expect(await result).toMatchObject({ok: true});
    const ends = mock.calls
      .filter((call) => call.op === 'RaiseCampaignTarget')
      .map((call) => [call.variables.id, call.variables.input.endDate]);
    expect(ends).toEqual([[store.id, '2026-09-30'], [later.id, '2026-10-03']]);
  });

  it("refuses to close a campaign that hasn't started", async () => {
    const {mock, result} = run(
      closing(running({startDate: '2026-10-05', endDate: '2026-10-20'}), [], () => ({})),
      {intent: 'close'},
    );
    expect(await result).toEqual({problems: ["This campaign hasn't started. Cancel it instead."]});
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });
});

describe('cancel', () => {
  it('keeps the IDs whose delete failed on the record', async () => {
    const entry = planned({
      status: 'running',
      markers: {campaign: 'a1', 'qr:hat': 'a2'},
      targets: {store: 't1', 'qr:hat': 't2'},
    });
    const {mock, result} = run(
      {
        ...base(entry),
        DeleteCampaignAnnotation: ({id}) => ({
          data: {analyticsAnnotationDelete: {userErrors: id === 'a2' ? [{message: 'Busy'}] : []}},
        }),
        DeleteCampaignTargets: () => ({data: {analyticsTargetsDelete: {deletedIds: ['t1'], userErrors: []}}}),
      },
      {intent: 'cancel'},
    );
    expect(await result).toEqual({problems: ['Busy']});
    expect(lastUpdate(mock.calls)).toEqual({markers: '{"qr:hat":"a2"}', targets: '{"qr:hat":"t2"}'});
  });
});

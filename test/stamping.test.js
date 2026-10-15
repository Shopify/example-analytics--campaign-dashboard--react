import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mockAdmin, ops} from './helpers/admin';
import {seedState, tablesOf} from './helpers/db';
import {base, planned, runWith, session} from './helpers/routes';
import {BULK_METAFIELDS_SET, readBulkOperation, readStamping} from '../app/bulk-stamp.server';
import {markMilestone, stampOrders} from '../app/campaign-mutations.server';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {action: campaignAction, loader} = await import('../app/routes/app.campaigns.$campaignId.jsx');
const {loader: statusLoader} = await import('../app/routes/app.campaigns.$campaignId.stamping.jsx');
const run = runWith(campaignAction);

const OPERATION = 'gid://shopify/BulkOperation/77';
const campaign = {
  id: 4210,
  gid: 'gid://shopify/Metaobject/1',
  shop: 'example.test',
  title: 'Summer launch',
  startDate: '2026-09-10',
  endDate: '2026-09-30',
  channels: ['email'],
  audience: 'everyone',
  products: [],
  creators: [],
  qrCodes: [],
  markers: {campaign: 'gid://shopify/AnalyticsAnnotation/9', email: 'gid://shopify/AnalyticsAnnotation/10'},
};

const orderRows = (rows) => () => ({data: {shopifyqlQuery: {tableData: {rows}, parseErrors: []}}});
const staged = () => ({
  data: {
    stagedUploadsCreate: {
      stagedTargets: [
        {
          url: 'https://uploads.test/bucket',
          parameters: [
            {name: 'key', value: 'tmp/bulk/order-stamps.jsonl'},
            {name: 'policy', value: 'abc'},
          ],
        },
      ],
      userErrors: [],
    },
  },
});
const started = () => ({
  data: {bulkOperationRunMutation: {bulkOperation: {id: OPERATION, status: 'CREATED'}, userErrors: []}},
});
const bulkHandlers = (rows) => ({
  CampaignOrders: orderRows(rows),
  StageBulkVariables: staged,
  RunBulkMutation: started,
});

let uploads;
beforeEach(() => {
  uploads = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    uploads.push({url, init});
    return new Response(null, {status: 201});
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('stampOrders', () => {
  it('uploads the stamps as JSONL and starts one bulk metafieldsSet', async () => {
    const rows = Array.from({length: 30}, (_unused, index) => ({order_id: String(1000 + index), day: '2026-09-12'}));
    const {admin, calls} = mockAdmin(bulkHandlers(rows));
    const result = await stampOrders(admin, campaign);

    expect(result).toEqual({operationId: OPERATION, count: 30, userErrors: []});
    expect(calls.find((call) => call.op === 'StageBulkVariables').variables.input).toEqual([
      {resource: 'BULK_MUTATION_VARIABLES', filename: 'campaign-4210-order-stamps.jsonl', mimeType: 'text/jsonl', httpMethod: 'POST'},
    ]);
    expect(calls.find((call) => call.op === 'RunBulkMutation').variables).toEqual({
      mutation: BULK_METAFIELDS_SET,
      stagedUploadPath: 'tmp/bulk/order-stamps.jsonl',
    });
    expect(BULK_METAFIELDS_SET).toMatch(/metafieldsSet\(metafields: \$metafields\)/);

    const [upload] = uploads;
    expect(upload.url).toBe('https://uploads.test/bucket');
    const fields = [...upload.init.body.keys()];
    expect(fields).toEqual(['key', 'policy', 'file']);
    const lines = (await upload.init.body.get('file').text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.metafields.length)).toEqual([25, 5]);
    expect(lines[0].metafields[0]).toMatchObject({
      ownerId: 'gid://shopify/Order/1000',
      namespace: '$app:campaign_dashboard',
      key: 'campaign_touch',
      type: 'single_line_text_field',
    });
  });

  it('starts nothing when no order follows a touch', async () => {
    const {admin, calls} = mockAdmin(bulkHandlers([]));
    expect(await stampOrders(admin, campaign)).toEqual({operationId: null, count: 0, userErrors: []});
    expect(ops(calls)).toEqual(['CampaignOrders']);
    expect(uploads).toEqual([]);
  });

  it('stops on an order read that does not parse', async () => {
    const {admin, calls} = mockAdmin({
      CampaignOrders: () => ({data: {shopifyqlQuery: {tableData: null, parseErrors: ['Unknown column order_id']}}}),
    });
    expect(await stampOrders(admin, campaign)).toEqual({
      operationId: null,
      count: 0,
      userErrors: [{message: 'Unknown column order_id'}],
    });
    expect(ops(calls)).toEqual(['CampaignOrders']);
  });

  it('returns a rejected bulk run', async () => {
    const {admin} = mockAdmin({
      ...bulkHandlers([{order_id: '1', day: '2026-09-12'}]),
      RunBulkMutation: () => ({
        data: {bulkOperationRunMutation: {bulkOperation: null, userErrors: [{field: null, message: 'Limit reached', code: 'LIMIT_REACHED'}]}},
      }),
    });
    const result = await stampOrders(admin, campaign);
    expect(result.operationId).toBeNull();
    expect(result.userErrors[0].message).toBe('Limit reached');
  });
});

describe('readBulkOperation', () => {
  const operation = (fields) => mockAdmin({StampOperation: () => ({data: {bulkOperation: {id: OPERATION, objectCount: '12', errorCode: null, url: null, ...fields}}})}).admin;

  it('reports a running operation with its count', async () => {
    expect(await readBulkOperation(operation({status: 'RUNNING'}), OPERATION)).toEqual({state: 'running', objectCount: 12, problems: []});
  });

  it('reads a completed operation clean when no line has errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":{"metafieldsSet":{"userErrors":[]}}}\n')));
    expect(await readBulkOperation(operation({status: 'COMPLETED', url: 'https://results.test/out'}), OPERATION)).toEqual({
      state: 'done',
      objectCount: 12,
      problems: [],
    });
  });

  it('fails a completed operation whose lines were rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        [
          '{"data":{"metafieldsSet":{"userErrors":[{"field":["metafields","0"],"message":"Owner not found","code":"INVALID"}]}}}',
          '{"errors":[{"message":"Variable $metafields is invalid"}]}',
        ].join('\n'),
      ),
    ));
    const result = await readBulkOperation(operation({status: 'COMPLETED', url: 'https://results.test/out'}), OPERATION);
    expect(result.state).toBe('failed');
    expect(result.problems).toEqual([{message: 'Owner not found'}, {message: 'Variable $metafields is invalid'}]);
  });

  it('reports a results line that does not parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":{"metafieldsSet"\n')));
    const result = await readBulkOperation(operation({status: 'COMPLETED', url: 'https://results.test/out'}), OPERATION);
    expect(result).toMatchObject({state: 'failed', problems: [{message: "A line in the bulk operation's results didn't parse."}]});
  });

  it('fails an operation that ended in a system error', async () => {
    const result = await readBulkOperation(operation({status: 'FAILED', errorCode: 'INTERNAL_SERVER_ERROR'}), OPERATION);
    expect(result).toMatchObject({state: 'failed', problems: [{message: 'The bulk operation ended failed (INTERNAL_SERVER_ERROR).'}]});
  });
});

describe('readStamping', () => {
  it('clears the operation once it completes clean', async () => {
    seedState({campaignId: 4210});
    tablesOf().campaignState[0].stampOperation = OPERATION;
    const {admin} = mockAdmin({StampOperation: () => ({data: {bulkOperation: {id: OPERATION, status: 'COMPLETED', objectCount: '0', url: null}}})});
    expect((await readStamping(admin, {...campaign, status: 'closed', stampOperation: OPERATION})).state).toBe('done');
    expect(tablesOf().campaignState[0].stampOperation).toBeNull();
  });

  it('keeps a failed operation for a retry', async () => {
    seedState({campaignId: 4210});
    tablesOf().campaignState[0].stampOperation = OPERATION;
    const {admin} = mockAdmin({StampOperation: () => ({data: {bulkOperation: {id: OPERATION, status: 'EXPIRED', objectCount: '3'}}})});
    expect((await readStamping(admin, {...campaign, status: 'closed', stampOperation: OPERATION})).state).toBe('failed');
    expect(tablesOf().campaignState[0].stampOperation).toBe(OPERATION);
  });
});

describe('markMilestone', () => {
  const target = {name: 'Store sales', expectedValue: '1000', shopifyqlQuery: 'FROM sales SHOW total_sales'};
  const money = (value) => `$${value}`;

  it('returns a measure that does not parse, not a target short of its goal', async () => {
    const {admin, calls} = mockAdmin({
      MeasureTarget: () => ({data: {shopifyqlQuery: {tableData: null, parseErrors: ['Unknown metric']}}}),
    });
    expect(await markMilestone(admin, target, '2026-09-20T13:00:00Z', money)).toEqual({userErrors: [{message: 'Unknown metric'}]});
    expect(ops(calls)).toEqual(['MeasureTarget']);
  });

  it('still refuses a target that is short of its goal', async () => {
    const {admin} = mockAdmin({
      MeasureTarget: () => ({data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '400'}]}, parseErrors: []}}}),
    });
    expect(await markMilestone(admin, target, '2026-09-20T13:00:00Z', money)).toEqual({userErrors: [{message: 'Target not reached yet.'}]});
  });
});

// The order dimension is queryable, so close and the retry stamp orders.
const queryableOrders = {
  AppMetafieldDefinitions: () => ({
    data: {
      products: {nodes: []},
      customers: {nodes: []},
      orders: {nodes: [{id: 'gid://shopify/MetafieldDefinition/8', key: 'campaign_touch', capabilities: {analyticsQueryable: {eligible: true, enabled: true}}}]},
    },
  }),
};

describe('close with order stamping', () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  });
  // Built in each test. The database starts empty for every test.
  const markers = {campaign: 'gid://shopify/AnalyticsAnnotation/9', email: 'gid://shopify/AnalyticsAnnotation/10'};
  const running = () => planned({status: 'running', markers});
  const closing = (overrides = {}, entry = running()) => ({
    ...base(entry),
    ...queryableOrders,
    CampaignSequence: () => ({data: {shopifyqlQuery: {tableData: {columns: [], rows: []}, parseErrors: []}}}),
    CampaignTargets: () => ({data: {targets: []}}),
    MeasureTarget: () => ({data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '500'}]}, parseErrors: []}}}),
    CloseCampaignAnnotation: () => ({data: {analyticsAnnotationUpdate: {userErrors: []}}}),
    ...bulkHandlers([{order_id: '1', day: '2026-09-12'}]),
    ...overrides,
  });

  it('records the bulk operation and closes without waiting for it', async () => {
    const {mock, result} = run(closing(), {intent: 'close'});
    expect(await result).toEqual({ok: true});
    expect(ops(mock.calls)).not.toContain('StampOperation');
    expect(tablesOf().campaignState[0].stampOperation).toBe(OPERATION);
  });

  it('stays open when the bulk operation fails to start', async () => {
    const {mock, result} = run(
      closing({StageBulkVariables: () => ({data: {stagedUploadsCreate: {stagedTargets: null, userErrors: [{field: ['input'], message: 'Invalid upload'}]}}})}),
      {intent: 'close'},
    );
    expect(await result).toEqual({problems: ['Invalid upload']});
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });

  it('closes without an operation when no order follows a touch', async () => {
    const {mock, result} = run(closing({CampaignOrders: orderRows([])}), {intent: 'close'});
    expect(await result).toEqual({ok: true});
    expect(ops(mock.calls)).not.toContain('StageBulkVariables');
    expect(tablesOf().campaignState[0]?.stampOperation ?? null).toBeNull();
  });

  it("stamps no order with a touch an early close took down", async () => {
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    const entry = planned({
      status: 'running',
      startDate: '2026-10-01',
      endDate: '2026-10-14',
      channels: ['email', 'sms'],
      markers: {...markers, sms: 'gid://shopify/AnalyticsAnnotation/11'},
    });
    const {mock, result} = run(
      closing(
        {
          RecordedAnnotations: ({ids}) => ({data: {annotations: ids.map((id) => ({id, createdByApp: {id: 'gid://shopify/App/7'}}))}}),
          DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
          ...bulkHandlers([{order_id: '1', day: '2026-10-07'}]),
        },
        entry,
      ),
      {intent: 'close'},
    );
    expect(await result).toEqual({ok: true});
    expect(mock.calls.find((call) => call.op === 'DeleteCampaignAnnotation').variables.id).toBe('gid://shopify/AnalyticsAnnotation/11');
    const [line] = (await uploads[0].init.body.get('file').text()).trim().split('\n').map((text) => JSON.parse(text));
    expect(line.metafields.map((field) => field.value)).toEqual(['Announcement for Summer launch']);
  });
});

describe('stamp-orders intent', () => {
  const closed = () => planned({status: 'closed', markers: {campaign: 'gid://shopify/AnalyticsAnnotation/9', email: 'gid://shopify/AnalyticsAnnotation/10'}});
  const withOperation = (status) => {
    tablesOf().campaignState[0].stampOperation = OPERATION;
    return {StampOperation: () => ({data: {bulkOperation: {id: OPERATION, status, objectCount: '1'}}})};
  };

  it('starts a new operation after a failed one', async () => {
    const handlers = {...base(closed()), ...queryableOrders, ...bulkHandlers([{order_id: '1', day: '2026-09-12'}])};
    const extra = withOperation('FAILED');
    const {mock, result} = run({...handlers, ...extra}, {intent: 'stamp-orders'});
    expect(await result).toEqual({ok: true});
    expect(ops(mock.calls)).toContain('RunBulkMutation');
    expect(tablesOf().campaignState[0].stampOperation).toBe(OPERATION);
  });

  it('clears a failed operation when nothing is left to stamp', async () => {
    const handlers = {...base(closed()), ...queryableOrders, ...bulkHandlers([])};
    const extra = withOperation('FAILED');
    const {mock, result} = run({...handlers, ...extra}, {intent: 'stamp-orders'});
    expect(await result).toEqual({ok: true});
    expect(ops(mock.calls)).not.toContain('RunBulkMutation');
    expect(tablesOf().campaignState[0].stampOperation).toBeNull();
  });

  it('refuses while the last operation still runs', async () => {
    const handlers = {...base(closed()), ...queryableOrders, ...bulkHandlers([{order_id: '1', day: '2026-09-12'}])};
    const extra = withOperation('RUNNING');
    const {mock, result} = run({...handlers, ...extra}, {intent: 'stamp-orders'});
    expect((await result).problems[0]).toMatch(/still being stamped/);
    expect(ops(mock.calls)).not.toContain('RunBulkMutation');
  });

  it('refuses a campaign that is still running', async () => {
    const {result} = run({...base(planned({status: 'running'})), ...queryableOrders}, {intent: 'stamp-orders'});
    expect((await result).problems[0]).toMatch(/Only closed campaigns/);
  });
});

describe('campaign page stamping status', () => {
  it('reads the recorded operation for a closed campaign', async () => {
    const closed = planned({status: 'closed', markers: {campaign: 'gid://shopify/AnnotationAnalytics/9'}});
    tablesOf().campaignState[0].stampOperation = OPERATION;
    const handlers = {...base(closed), StampOperation: () => ({data: {bulkOperation: {id: OPERATION, status: 'RUNNING', objectCount: '4'}}})};
    const mock = mockAdmin(
      new Proxy(handlers, {
        get: (target, op) =>
          target[op] ??
          (() => ({data: {shop: {currencyCode: 'USD', ianaTimezone: 'Etc/UTC'}, shopifyqlQuery: {tableData: {columns: [], rows: []}, parseErrors: []}}})),
      }),
    );
    session.admin = mock.raw;
    const data = await loader({request: new Request('https://app.test/app/campaigns/4210'), params: {campaignId: '4210'}});
    expect(data.stamping).toEqual({state: 'running', objectCount: 4, problems: []});
  });
});

describe('stamping status route', () => {
  const poll = () =>
    statusLoader({request: new Request('https://app.test/app/campaigns/4210/stamping'), params: {campaignId: '4210'}});

  it('reads only the recorded bulk operation', async () => {
    seedState({campaignId: 4210});
    tablesOf().campaignState[0].stampOperation = OPERATION;
    const mock = mockAdmin({StampOperation: () => ({data: {bulkOperation: {id: OPERATION, status: 'RUNNING', objectCount: '9'}}})});
    session.admin = mock.raw;
    expect(await poll()).toEqual({state: 'running', objectCount: 9, problems: []});
    expect(ops(mock.calls)).toEqual(['StampOperation']);
  });

  it('reports done once the record is cleared', async () => {
    const mock = mockAdmin({});
    session.admin = mock.raw;
    expect((await poll()).state).toBe('done');
    expect(mock.calls).toHaveLength(0);
  });
});

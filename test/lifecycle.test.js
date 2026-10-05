import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {STALE_MESSAGE} from '../app/campaigns.server';
import {ops} from './helpers/admin';
import {listOf, node} from './helpers/campaign';
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
    expect(lastUpdate(mock.calls)).toMatchObject({status: 'running', targets: '{}'});
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

  it('fails one of two concurrent activations and deletes its unrecorded mark', async () => {
    const entry = planned({updatedAt: '2026-09-30T10:00:00Z'});
    const {mock, result} = run(
      {
        ...base(entry),
        ...marking,
        CampaignVersion: () => ({data: {metaobject: {updatedAt: '2026-09-30T10:00:00Z'}}}),
        UpdateCampaign: () => ({
          data: {metaobjectUpdate: {metaobject: planned({updatedAt: '2026-09-30T10:01:00Z'}), userErrors: []}},
        }),
        CampaignById: () => ({data: {metaobject: planned({updatedAt: '2026-09-30T10:02:00Z'})}}),
        CreateCampaignAnnotation: () => ({
          data: {analyticsAnnotationCreate: {analyticsAnnotation: {id: 'gid://shopify/AnalyticsAnnotation/77'}, userErrors: []}},
        }),
        RecordedAnnotations: ({ids}) => ({
          data: {annotations: ids.map((id) => ({id, createdByApp: {id: 'gid://shopify/App/7'}}))},
        }),
        DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({problems: [STALE_MESSAGE]});
    expect(mock.calls.filter((call) => call.op === 'DeleteCampaignAnnotation').map((call) => call.variables.id)).toEqual([
      'gid://shopify/AnalyticsAnnotation/77',
    ]);
    expect(ops(mock.calls).filter((op) => op === 'UpdateCampaign')).toHaveLength(1);
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

  it("warns on a TAKEN store target and doesn't record another campaign's ID", async () => {
    const {mock, result} = run(
      {
        ...base(planned({revenueTarget: '100'})),
        ...marking,
        CreateCampaignTarget: () => ({
          data: {
            analyticsTargetCreate: {
              analyticsTarget: {id: 'gid://shopify/AnalyticsTarget/50'},
              userErrors: [{field: ['input'], code: 'TAKEN', message: 'Target already exists'}],
            },
          },
        }),
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({
      ok: true,
      problems: [
        'This campaign has no store-wide sales target. Another target on the same dates already measures the same sales, and Shopify identifies a target by its metric, dates, and filters.',
      ],
    });
    expect(lastUpdate(mock.calls)).toMatchObject({status: 'running', targets: '{}'});
    const writes = mock.calls.filter((call) => call.op === 'UpdateCampaign');
    expect(JSON.stringify(writes)).not.toContain('AnalyticsTarget/50');
  });

  it('saves the new vip members and unstamps the earlier vip campaign\'s dropouts', async () => {
    const entry = planned({audience: 'vip'});
    const earlier = node({gid: 'g0', id: 4200, audience: 'vip', status: 'closed', members: ['gid://shopify/Customer/1', 'gid://shopify/Customer/2']});
    const {mock, result} = run(
      {
        ...base(entry),
        ...marking,
        CampaignList: listOf([earlier, entry]),
        AudienceRanking: () => ({data: {shopifyqlQuery: {tableData: {rows: [{customer_id: '2'}, {customer_id: '3'}]}, parseErrors: []}}}),
        SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
        CustomerTiers: ({ids}) => ({data: {nodes: ids.map((id) => ({id, tier: {value: 'vip'}}))}}),
        DeleteCustomerTier: () => ({data: {metafieldsDelete: {userErrors: []}}}),
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({ok: true});
    expect(mock.calls.find((call) => call.op === 'DeleteCustomerTier').variables.metafields.map((field) => field.ownerId)).toEqual([
      'gid://shopify/Customer/1',
    ]);
    expect(JSON.parse(lastUpdate(mock.calls).members)).toEqual(['gid://shopify/Customer/2', 'gid://shopify/Customer/3']);
  });

  it('rejects a campaign that already runs', async () => {
    const {mock, result} = run({...base(planned({status: 'running'}))}, {intent: 'activate'});
    expect(await result).toEqual({problems: ['This campaign is active. Only a planned campaign can be activated.']});
    expect(ops(mock.calls)).not.toContain('CreateCampaignAnnotation');
  });

  it('deletes the new targets when saving their IDs is throttled', async () => {
    const {mock, result} = run(
      {
        ...base(planned({revenueTarget: '100'})),
        ...marking,
        ...targeting,
        UpdateCampaign: ({metaobject}) =>
          metaobject.fields.some((field) => field.key === 'targets')
            ? {errors: [{message: 'Throttled'}], data: null}
            : {data: {metaobjectUpdate: {metaobject: null, userErrors: []}}},
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({problems: ['Throttled']});
    expect(mock.calls.find((call) => call.op === 'DeleteCampaignTargets').variables.ids).toEqual(['gid://shopify/AnalyticsTarget/1']);
  });
});

describe('lock', () => {
  it('refuses a write while another request holds the campaign', async () => {
    const {mock, result} = run(
      {
        ...base(planned()),
        CampaignLock: () => ({
          data: {currentAppInstallation: {id: 'gid://shopify/AppInstallation/1', metafield: {value: '2026-09-30T11:59:00Z', compareDigest: 'd1'}}},
        }),
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({problems: ['Another change to this campaign is in progress. Reload in a moment.']});
    expect(ops(mock.calls)).toEqual(['CampaignLock']);
  });

  it('takes over a lock older than five minutes with its digest', async () => {
    const {mock, result} = run(
      {
        ...base(planned({status: 'running'})),
        CampaignLock: () => ({
          data: {currentAppInstallation: {id: 'gid://shopify/AppInstallation/1', metafield: {value: '2026-09-30T11:50:00Z', compareDigest: 'd1'}}},
        }),
      },
      {intent: 'activate'},
    );
    await result;
    expect(mock.calls.find((call) => call.op === 'TakeCampaignLock').variables.metafields[0].compareDigest).toBe('d1');
  });

  it('refuses when another request takes the lock first', async () => {
    const {mock, result} = run(
      {
        ...base(planned()),
        TakeCampaignLock: () => ({data: {metafieldsSet: {userErrors: [{code: 'STALE_OBJECT', message: 'The resource has been updated since it was loaded.'}]}}}),
      },
      {intent: 'activate'},
    );
    expect(await result).toEqual({problems: ['Another change to this campaign is in progress. Reload in a moment.']});
    expect(ops(mock.calls)).not.toContain('CampaignList');
    expect(mock.calls[1].variables.metafields[0].compareDigest).toBeNull();
  });

  it('releases the lock after a write that fails partway', async () => {
    const {mock, result} = run(
      {...base(planned()), ...marking, CreateCampaignAnnotation: () => ({errors: [{message: 'Throttled'}], data: null})},
      {intent: 'activate'},
    );
    expect(await result).toEqual({problems: ['Throttled']});
    expect(ops(mock.calls).at(-1)).toBe('ReleaseCampaignLock');
  });
});

describe('lock release', () => {
  it("keeps the write's result when the release fails", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {result} = run(
      {...base(planned()), ReleaseCampaignLock: () => new Response(null, {status: 401})},
      {intent: 'set-targets', revenueTarget: '100'},
    );
    expect(await result).toEqual({ok: true});
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

  it('removes the marks dated after an early close', async () => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const ids = {campaign: 9, vip: 10, promo: 11};
    const markers = Object.fromEntries(
      Object.entries(ids).map(([key, id]) => [key, `gid://shopify/AnalyticsAnnotation/${id}`]),
    );
    const {mock, result} = run(
      {
        ...closing(running({markers, audience: 'vip', products: [{id: 'gid://shopify/Product/1', title: 'Hat'}]}), [], () => ({data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '10'}]}, parseErrors: []}}})),
        RecordedAnnotations: ({ids: asked}) => ({
          data: {annotations: asked.map((id) => ({id, createdByApp: {id: 'gid://shopify/App/7'}}))},
        }),
        DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
      },
      {intent: 'close'},
    );
    expect(await result).toMatchObject({ok: true});
    const deleted = mock.calls.filter((call) => call.op === 'DeleteCampaignAnnotation').map((call) => call.variables.id);
    expect(deleted).toEqual([markers.promo]);
    expect(JSON.parse(lastUpdate(mock.calls).markers)).toEqual({campaign: markers.campaign, vip: markers.vip});
  });

  it('removes a recorded mark the campaign no longer produces and keeps milestones', async () => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    const markers = {
      campaign: 'gid://shopify/AnalyticsAnnotation/9',
      vip: 'gid://shopify/AnalyticsAnnotation/10',
      'milestone:1:2026-09-12': 'gid://shopify/AnalyticsAnnotation/12',
    };
    const {mock, result} = run(
      {
        ...closing(running({markers}), [], () => ({data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '10'}]}, parseErrors: []}}})),
        RecordedAnnotations: ({ids: asked}) => ({
          data: {annotations: asked.map((id) => ({id, createdByApp: {id: 'gid://shopify/App/7'}}))},
        }),
        DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
      },
      {intent: 'close'},
    );
    expect(await result).toMatchObject({ok: true});
    const deleted = mock.calls.filter((call) => call.op === 'DeleteCampaignAnnotation').map((call) => call.variables.id);
    expect(deleted).toEqual([markers.vip]);
    expect(Object.keys(JSON.parse(lastUpdate(mock.calls).markers))).toEqual(['campaign', 'milestone:1:2026-09-12']);
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

  it('closes with a warning when another target already has the shortened dates', async () => {
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const store = {id: 'gid://shopify/AnalyticsTarget/3', name: 'Summer launch: store-wide sales', startDate: '2026-09-10', endDate: '2026-10-07', expectedValue: '2000', shopifyqlQuery: 'FROM sales SHOW total_sales'};
    const product = {id: 'gid://shopify/AnalyticsTarget/4', name: 'Summer launch: promoted products', startDate: '2026-09-10', endDate: '2026-10-07', expectedValue: '500', shopifyqlQuery: 'FROM sales SHOW total_sales'};
    const {mock, result} = run(
      {
        ...closing(running({targets: {store: store.id, product: product.id}}), [store, product], () => ({
          data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '1000'}]}, parseErrors: []}},
        })),
        RaiseCampaignTarget: ({id}) => ({
          data: {analyticsTargetUpdate: {userErrors: id === store.id ? [{field: ['input'], code: 'TAKEN', message: 'Target already exists'}] : []}},
        }),
      },
      {intent: 'close'},
    );
    expect(await result).toEqual({
      ok: true,
      problems: ['Summer launch: store-wide sales keeps its end date of 2026-10-07. Another target already measures the same sales from 2026-09-10 to 2026-09-20.'],
    });
    const ends = mock.calls.filter((call) => call.op === 'RaiseCampaignTarget').map((call) => call.variables.id);
    expect(ends).toEqual([store.id, product.id]);
    expect(lastUpdate(mock.calls)).toEqual({end_date: '2026-09-20', status: 'closed'});
  });

  it('still blocks the close on any other target error', async () => {
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const store = {id: 'gid://shopify/AnalyticsTarget/3', name: 'Summer launch: store-wide sales', startDate: '2026-09-10', endDate: '2026-10-07'};
    const {mock, result} = run(
      {
        ...closing(running({targets: {store: store.id}}), [store], () => ({})),
        RaiseCampaignTarget: () => ({data: {analyticsTargetUpdate: {userErrors: [{code: 'INVALID', message: 'End date is invalid'}]}}}),
      },
      {intent: 'close'},
    );
    expect(await result).toEqual({problems: ['End date is invalid']});
    expect(ops(mock.calls)).not.toContain('CloseCampaignAnnotation');
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
      markers: {campaign: 'gid://shopify/AnalyticsAnnotation/1', 'qr:hat': 'gid://shopify/AnalyticsAnnotation/2'},
      targets: {store: 'gid://shopify/AnalyticsTarget/1', 'qr:hat': 'gid://shopify/AnalyticsTarget/2'},
    });
    const {mock, result} = run(
      {
        ...base(entry),
        RecordedAnnotations: ({ids}) => ({data: {annotations: ids.map((id) => ({id, createdByApp: {id: 'gid://shopify/App/7'}}))}}),
        CampaignTargets: ({ids}) => ({data: {targets: ids.map((id) => ({id, name: 'Summer launch: store-wide sales'}))}}),
        DeleteCampaignAnnotation: ({id}) => ({
          data: {analyticsAnnotationDelete: {userErrors: id === 'gid://shopify/AnalyticsAnnotation/2' ? [{message: 'Busy'}] : []}},
        }),
        DeleteCampaignTargets: () => ({data: {analyticsTargetsDelete: {deletedIds: ['gid://shopify/AnalyticsTarget/1'], userErrors: []}}}),
      },
      {intent: 'cancel'},
    );
    expect(await result).toEqual({problems: ['Busy', "Couldn't delete every target. Cancel the campaign again."]});
    expect(lastUpdate(mock.calls)).toEqual({markers: '{"qr:hat":"gid://shopify/AnalyticsAnnotation/2"}', targets: '{"qr:hat":"gid://shopify/AnalyticsTarget/2"}'});
  });

  it('deletes the recorded targets after the campaign was renamed', async () => {
    const entry = planned({
      title: 'Autumn launch',
      status: 'running',
      targets: {store: 'gid://shopify/AnalyticsTarget/1', 'qr:hat': 'gid://shopify/AnalyticsTarget/2'},
    });
    const names = {
      'gid://shopify/AnalyticsTarget/1': 'Summer launch: store-wide sales',
      'gid://shopify/AnalyticsTarget/2': 'Summer launch: Hat QR code',
    };
    const {mock, result} = run(
      {
        ...base(entry),
        CampaignTargets: ({ids}) => ({data: {targets: ids.map((id) => ({id, name: names[id]}))}}),
        DeleteCampaignTargets: ({ids}) => ({data: {analyticsTargetsDelete: {deletedIds: ids, userErrors: []}}}),
      },
      {intent: 'cancel'},
    );
    expect(await result).toEqual({ok: true});
    expect(mock.calls.find((call) => call.op === 'DeleteCampaignTargets').variables.ids).toEqual(Object.keys(names));
    expect(lastUpdate(mock.calls)).toMatchObject({status: 'canceled', targets: '{}'});
  });

  it('keeps the recorded targets when they fail to read', async () => {
    const entry = planned({status: 'running', targets: {store: 'gid://shopify/AnalyticsTarget/1'}});
    const {mock, result} = run(
      {
        ...base(entry),
        CampaignTargets: () => ({errors: [{message: 'Throttled'}]}),
      },
      {intent: 'cancel'},
    );
    expect(await result).toEqual({problems: ['Throttled']});
    expect(lastUpdate(mock.calls)).toEqual({markers: '{}', targets: '{"store":"gid://shopify/AnalyticsTarget/1"}'});
  });
});

describe('guards', () => {
  it('creates only the targets a failed activation left missing', async () => {
    const entry = planned({
      products: [{id: 'gid://shopify/Product/1', title: 'Hat'}],
      revenueTarget: '100',
      productTarget: '50',
      targets: {store: 'gid://shopify/AnalyticsTarget/77'},
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
    await result;
    const created = mock.calls.filter((call) => call.op === 'CreateCampaignTarget').map((call) => call.variables.input.name);
    expect(created).toEqual(['Summer launch: promoted products']);
    expect(JSON.parse(lastUpdate(mock.calls).targets)).toMatchObject({store: 'gid://shopify/AnalyticsTarget/77'});
  });

  it('refuses target edits after activation', async () => {
    const {mock, result} = run(base(planned({status: 'running'})), {intent: 'set-targets', revenueTarget: '10'});
    expect((await result).problems[0]).toMatch(/before the campaign is activated/);
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });

  it('refuses a milestone day outside the campaign', async () => {
    const {result} = run(base(planned({status: 'running'})), {intent: 'milestone', day: 'not-a-day', targetId: 'x'});
    expect((await result).problems[0]).toMatch(/inside the campaign/);
  });

  it('refuses to raise a target that is not reached', async () => {
    const target = {id: 'gid://shopify/AnalyticsTarget/5', expectedValue: '10000', shopifyqlQuery: 'FROM sales SHOW total_sales'};
    const entry = planned({status: 'running', targets: {store: target.id}});
    const {mock, result} = run(
      {
        ...base(entry),
        CampaignTargets: () => ({data: {targets: [target]}}),
        MeasureTarget: () => ({data: {shopifyqlQuery: {tableData: {rows: [{total_sales: '3000'}]}, parseErrors: []}}}),
      },
      {intent: 'raise-target', targetId: target.id},
    );
    expect((await result).problems[0]).toMatch(/reached yet/);
    expect(ops(mock.calls)).not.toContain('RaiseCampaignTarget');
  });
});

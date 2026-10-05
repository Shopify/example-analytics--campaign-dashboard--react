import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createProductTarget,
  createQrTargets,
  createStoreTarget,
  stampProducts,
  recordMark,
  stampTier,
  writeMarks,
} from '../app/campaign-mutations.server';
import {mockAdmin} from './helpers/admin';
import {node} from './helpers/campaign';

const campaign = (overrides = {}) => ({
  gid: 'gid://shopify/Metaobject/1',
  id: 4210,
  title: 'Summer launch',
  startDate: '2026-09-10',
  endDate: '2026-10-07',
  channels: ['email'],
  products: [],
  qrCodes: [],
  audience: 'everyone',
  members: [],
  creatorCodes: [],
  markers: {},
  targets: {},
  ...overrides,
});

const codes = (...handles) => handles.map((handle, index) => ({id: `q${index}`, handle}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('targets', () => {
  const created = (id) => () => ({
    data: {analyticsTargetCreate: {analyticsTarget: {id}, userErrors: []}},
  });

  it('skips the store and product targets without an amount', async () => {
    const {admin, calls} = mockAdmin({});
    expect(await createStoreTarget(admin, campaign({revenueTarget: ''}))).toEqual({id: null, userErrors: []});
    expect(
      await createProductTarget(admin, campaign({products: [{id: 'gid://shopify/Product/1', title: 'Hat'}], productTarget: ''})),
    ).toEqual({id: null, userErrors: []});
    expect(calls).toEqual([]);
  });

  it('creates one attribution target per QR code, keyed by handle', async () => {
    const {admin, calls} = mockAdmin({CreateCampaignTarget: created('t1')});
    const {targets, userErrors} = await createQrTargets(
      admin,
      campaign({qrCodes: codes('a', 'b'), qrTarget: '500'}),
    );
    expect(userErrors).toEqual([]);
    expect(Object.keys(targets)).toEqual(['qr:a', 'qr:b']);
    expect(calls.map((call) => call.variables.input)).toEqual([
      expect.objectContaining({metric: 'campaign_last_non_direct_click_total_sales', filters: "utm_campaign = 'a'", expectedValue: '500'}),
      expect.objectContaining({filters: "utm_campaign = 'b'"}),
    ]);
  });

  it('creates no QR code target without an amount', async () => {
    const {admin, calls} = mockAdmin({});
    expect(await createQrTargets(admin, campaign({qrCodes: codes('a'), qrTarget: ''}))).toEqual({targets: {}, userErrors: []});
    expect(calls).toEqual([]);
  });

  it('reports a rejected QR code target and keeps the rest', async () => {
    const {admin} = mockAdmin({
      CreateCampaignTarget: ({input}) =>
        input.filters.includes("'a'")
          ? {data: {analyticsTargetCreate: {analyticsTarget: null, userErrors: [{message: 'Duplicate'}]}}}
          : {data: {analyticsTargetCreate: {analyticsTarget: {id: 't2'}, userErrors: []}}},
    });
    const result = await createQrTargets(admin, campaign({qrCodes: codes('a', 'b'), qrTarget: '5'}));
    expect(result).toEqual({targets: {'qr:b': 't2'}, userErrors: [{message: 'Duplicate'}]});
  });

  // Shopify returns TAKEN with the target that already has the metric, dates, and filters.
  const taken = () => ({
    data: {
      analyticsTargetCreate: {
        analyticsTarget: {id: 'gid://shopify/AnalyticsTarget/1'},
        userErrors: [{field: ['input'], code: 'TAKEN', message: 'Target already exists'}],
      },
    },
  });

  it("keeps no ID from a TAKEN store target and names what's missing", async () => {
    const {admin} = mockAdmin({CreateCampaignTarget: taken});
    const result = await createStoreTarget(admin, campaign({revenueTarget: '1000'}));
    expect(result.id).toBeNull();
    expect(result.userErrors).toEqual([
      expect.objectContaining({
        code: 'TAKEN',
        message:
          'This campaign has no store-wide sales target. Another target on the same dates already measures the same sales, and Shopify identifies a target by its metric, dates, and filters.',
      }),
    ]);
  });

  it('keeps no ID from a TAKEN product or QR code target', async () => {
    const {admin} = mockAdmin({CreateCampaignTarget: taken});
    const product = await createProductTarget(
      admin,
      campaign({products: [{id: 'gid://shopify/Product/1', title: 'Hat'}], productTarget: '400'}),
    );
    expect(product.id).toBeNull();
    const qr = await createQrTargets(admin, campaign({qrCodes: codes('a'), qrTarget: '5'}));
    expect(qr.targets).toEqual({});
    expect(qr.userErrors[0].message).toMatch(/^This campaign has no a QR code target\./);
  });
});

describe('writeMarks', () => {
  it('clears the mark of a code that moved to another campaign', async () => {
    const appId = 'gid://shopify/App/7';
    const {admin, calls} = mockAdmin({
      RecordedAnnotations: () => ({
        data: {
          annotations: [
            {id: 'gid://shopify/AnalyticsAnnotation/1', createdByApp: {id: appId}},
          ],
        },
      }),
      DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
      CreateCampaignAnnotation: () => ({
        data: {analyticsAnnotationCreate: {analyticsAnnotation: {id: `a${calls.length}`}, userErrors: []}},
      }),
      CampaignById: () => ({data: {metaobject: null}}),
      UpdateCampaign: () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: []}}}),
    });
    const moved = campaign({qrCodes: codes('kept'), markers: {'qr:moved': 'gid://shopify/AnalyticsAnnotation/1', 'milestone:9:2026-09-12': 'm1', 'incident:2026-09-13': 'i1'}});
    const {markers, problems} = await writeMarks(admin, moved, appId, (date) => `${date}T09:00:00Z`);
    expect(problems).toEqual([]);
    expect(calls.filter((call) => call.op === 'DeleteCampaignAnnotation').map((call) => call.variables.id)).toEqual(['gid://shopify/AnalyticsAnnotation/1']);
    expect(markers).not.toHaveProperty('qr:moved');
    expect(markers).toHaveProperty('qr:kept');
    expect(markers['milestone:9:2026-09-12']).toBe('m1');
    expect(markers['incident:2026-09-13']).toBe('i1');
  });

  it('clears the promo mark once the products are gone', async () => {
    const appId = 'gid://shopify/App/7';
    const {admin, calls} = mockAdmin({
      RecordedAnnotations: ({ids}) => ({data: {annotations: ids.map((id) => ({id, createdByApp: {id: appId}}))}}),
      DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
      CreateCampaignAnnotation: () => ({
        data: {analyticsAnnotationCreate: {analyticsAnnotation: {id: `a${calls.length}`}, userErrors: []}},
      }),
      CampaignById: () => ({data: {metaobject: null}}),
      UpdateCampaign: () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: []}}}),
    });
    const bare = campaign({markers: {promo: 'gid://shopify/AnalyticsAnnotation/5', launch: 'gid://shopify/AnalyticsAnnotation/6'}});
    const {markers, problems} = await writeMarks(admin, bare, appId, (date) => `${date}T09:00:00Z`);
    expect(problems).toEqual([]);
    expect(calls.filter((call) => call.op === 'DeleteCampaignAnnotation').map((call) => call.variables.id)).toEqual([
      'gid://shopify/AnalyticsAnnotation/5',
      'gid://shopify/AnalyticsAnnotation/6',
    ]);
    expect(Object.keys(markers).sort()).toEqual(['campaign', 'email']);
  });
});

describe('stampProducts', () => {
  it('writes a campaign reference onto each promoted product', async () => {
    const {admin, calls} = mockAdmin({
      SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
    });
    await stampProducts(admin, campaign({products: [{id: 'p1', title: 'Hat'}]}));
    expect(calls[0].variables.metafields).toEqual([
      {ownerId: 'p1', namespace: '$app:campaign_dashboard', key: 'campaign', type: 'metaobject_reference', value: 'gid://shopify/Metaobject/1'},
    ]);
  });
});

describe('stampTier', () => {
  const ranked = (...ids) => () => ({
    data: {shopifyqlQuery: {tableData: {rows: ids.map((id) => ({customer_id: id}))}, parseErrors: []}},
  });
  const customer = (id) => `gid://shopify/Customer/${id}`;
  const stamps = (tiers) => ({ids}) => ({
    data: {nodes: ids.map((id) => ({id, tier: tiers[id] ? {value: tiers[id]} : null}))},
  });
  const earlier = [
    campaign({gid: 'g0', audience: 'vip', members: [customer(1), customer(2)]}),
    campaign({gid: 'g5', audience: 'vip', members: [customer(4), customer(8)]}),
    campaign({gid: 'g6', audience: 'regulars', members: [customer(7)]}),
  ];

  it('clears the earlier members who dropped out of the tier', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: ranked('2', '3'),
      SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
      // 4 joined a later regulars campaign. 8's stamp is already gone.
      CustomerTiers: stamps({[customer(1)]: 'vip', [customer(4)]: 'regulars'}),
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {userErrors: []}}}),
    });
    const vip = campaign({audience: 'vip'});
    expect(await stampTier(admin, vip, [vip, ...earlier])).toEqual({
      members: [customer(2), customer(3)],
      userErrors: [],
    });
    expect(calls.find((call) => call.op === 'CustomerTiers').variables.ids).toEqual([
      customer(1),
      customer(4),
      customer(8),
    ]);
    expect(calls.find((call) => call.op === 'DeleteCustomerTier').variables.metafields).toEqual([
      {ownerId: customer(1), namespace: '$app:campaign_dashboard', key: 'tier'},
    ]);
  });

  it('leaves every vip stamp on a customer the new rank holds', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: ranked('1', '2', '4', '8'),
      SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
    });
    const vip = campaign({audience: 'vip'});
    const {members} = await stampTier(admin, vip, [vip, ...earlier]);
    expect(members).toHaveLength(4);
    expect(calls.map((call) => call.op)).toEqual(['AudienceRanking', 'SetCampaignMetafields']);
  });

  it('keeps the earlier campaigns listing customers whose stamps failed to clear', async () => {
    const {admin} = mockAdmin({
      AudienceRanking: ranked('3'),
      SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
      CustomerTiers: stamps({[customer(1)]: 'vip'}),
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {userErrors: [{message: 'Throttled'}]}}}),
    });
    const vip = campaign({audience: 'vip'});
    const result = await stampTier(admin, vip, [vip, ...earlier]);
    expect(result).toEqual({members: [customer(3)], userErrors: [{message: 'Throttled'}]});
    expect(earlier[0].members).toContain(customer(1));
  });

  it('stamps nobody on a ranking that does not parse', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: () => ({data: {shopifyqlQuery: {tableData: null, parseErrors: ['Bad query']}}}),
    });
    expect(await stampTier(admin, campaign({audience: 'vip'}), earlier)).toEqual({
      members: [],
      userErrors: [{message: 'Bad query'}],
    });
    expect(calls).toHaveLength(1);
  });
});

describe('recordMark', () => {
  it('deletes the annotation it created when saving its ID fails', async () => {
    const {admin, calls} = mockAdmin({
      CampaignById: () => ({data: {metaobject: node({id: 4210, updatedAt: '2026-09-20T10:05:00Z'})}}),
      DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
    });
    const stale = campaign({updatedAt: '2026-09-20T10:00:00Z'});
    const {userErrors} = await recordMark(admin, stale, 'milestone:2026-09-20', 'gid://shopify/AnalyticsAnnotation/5');
    expect(userErrors.map((error) => error.code)).toEqual(['STALE']);
    expect(calls.find((call) => call.op === 'DeleteCampaignAnnotation').variables).toEqual({
      id: 'gid://shopify/AnalyticsAnnotation/5',
    });
  });
});

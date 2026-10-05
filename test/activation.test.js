import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createProductTarget,
  createQrTargets,
  createStoreTarget,
  stampProducts,
  stampTier,
  writeMarks,
} from '../app/campaign-mutations.server';
import {mockAdmin} from './helpers/admin';

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
    const moved = campaign({qrCodes: codes('kept'), markers: {'qr:moved': 'gid://shopify/AnalyticsAnnotation/1', milestone: 'm1'}});
    const {markers, problems} = await writeMarks(admin, moved, appId, (date) => `${date}T09:00:00Z`);
    expect(problems).toEqual([]);
    expect(calls.filter((call) => call.op === 'DeleteCampaignAnnotation').map((call) => call.variables.id)).toEqual(['gid://shopify/AnalyticsAnnotation/1']);
    expect(markers).not.toHaveProperty('qr:moved');
    expect(markers).toHaveProperty('qr:kept');
    expect(markers.milestone).toBe('m1');
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
  const roster = (value) => () => ({
    data: {currentAppInstallation: {id: 'gid://shopify/AppInstallation/1', roster: value ? {jsonValue: value} : null}},
  });

  it('clears the customers who dropped out of the tier', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: ranked('2', '3'),
      TierRoster: roster({
        'gid://shopify/Customer/1': 'vip',
        'gid://shopify/Customer/2': 'vip',
        'gid://shopify/Customer/9': 'regulars',
      }),
      SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {userErrors: []}}}),
    });
    expect(await stampTier(admin, campaign({audience: 'vip'}))).toEqual([]);
    const cleared = calls.find((call) => call.op === 'DeleteCustomerTier');
    expect(cleared.variables.metafields).toEqual([
      {ownerId: 'gid://shopify/Customer/1', namespace: '$app:campaign_dashboard', key: 'tier'},
    ]);
    const saved = calls.filter((call) => call.op === 'SetCampaignMetafields').at(-1).variables.metafields[0];
    expect(JSON.parse(saved.value)).toEqual({
      'gid://shopify/Customer/2': 'vip',
      'gid://shopify/Customer/3': 'vip',
      'gid://shopify/Customer/9': 'regulars',
    });
  });

  it('stamps nobody on a ranking that does not parse', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: () => ({data: {shopifyqlQuery: {tableData: null, parseErrors: ['Bad query']}}}),
    });
    expect(await stampTier(admin, campaign({audience: 'vip'}))).toEqual([{message: 'Bad query'}]);
    expect(calls).toHaveLength(1);
  });
});

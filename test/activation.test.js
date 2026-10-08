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
import {SHOP, db, storedState} from './helpers/db';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const campaign = (overrides = {}) => ({
  shop: SHOP,
  gid: 'gid://shopify/Metaobject/1',
  id: 4210,
  title: 'Summer launch',
  startDate: '2026-09-10',
  endDate: '2026-10-07',
  channels: ['email'],
  products: [],
  qrCodes: [],
  audience: 'everyone',
  creators: [],
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
  const rows = (...ids) => () => ({
    data: {shopifyqlQuery: {tableData: {rows: ids.map((id) => ({customer_id: id}))}, parseErrors: []}},
  });
  const customer = (id) => `gid://shopify/Customer/${id}`;
  const dimension = 'customer.metafields."app--7--campaign_dashboard".tier';
  const queryable = {enabled: true, dimension};
  const stamped = () => ({data: {metafieldsSet: {userErrors: []}}});
  const vip = campaign({audience: 'vip'});

  it('unstamps the current holders who dropped out of the tier', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: rows('2', '3'),
      SetCampaignMetafields: stamped,
      CampaignTierHolders: rows('1', '2', '4'),
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {userErrors: []}}}),
    });
    expect(await stampTier(admin, vip, queryable)).toEqual({userErrors: []});
    expect(calls.find((call) => call.op === 'SetCampaignMetafields').variables.metafields.map((field) => field.ownerId)).toEqual([
      customer(2),
      customer(3),
    ]);
    expect(calls.find((call) => call.op === 'DeleteCustomerTier').variables.metafields).toEqual([
      {ownerId: customer(1), namespace: '$app:campaign_dashboard', key: 'tier'},
      {ownerId: customer(4), namespace: '$app:campaign_dashboard', key: 'tier'},
    ]);
  });

  it('finds the holders by the tier dimension, with no date range', async () => {
    const documents = [];
    const {raw} = mockAdmin({
      AudienceRanking: rows('1'),
      SetCampaignMetafields: stamped,
      CampaignTierHolders: rows('1'),
    });
    const admin = {graphql: (document, options) => (documents.push(document), raw.graphql(document, options))};
    await stampTier(admin, vip, queryable);
    expect(documents.at(-1)).toContain(
      `FROM customers SHOW total_number_of_orders WHERE customer.metafields.\\"app--7--campaign_dashboard\\".tier = 'vip' GROUP BY customer_id ORDER BY customer_id ASC LIMIT 1000`,
    );
  });

  it('pages the holders with OFFSET until a short page', async () => {
    const page = Array.from({length: 1000}, (_unused, index) => String(index + 10));
    const {admin, calls} = mockAdmin({
      AudienceRanking: rows('10'),
      SetCampaignMetafields: stamped,
      CampaignTierHolders: (_variables, seen) =>
        seen.filter((call) => call.op === 'CampaignTierHolders').length === 1 ? rows(...page)() : rows('5000')(),
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {userErrors: []}}}),
    });
    const documents = [];
    const spy = {graphql: (document, options) => (documents.push(document), admin.graphql(document, options))};
    expect(await stampTier(spy, vip, queryable)).toEqual({userErrors: []});
    const holderQueries = documents.filter((document) => document.includes('CampaignTierHolders'));
    expect(holderQueries).toHaveLength(2);
    expect(holderQueries[0]).toMatch(/ORDER BY customer_id ASC LIMIT 1000"/);
    expect(holderQueries[1]).toMatch(/ORDER BY customer_id ASC LIMIT 1000 OFFSET 1000"/);
    const deleted = calls.find((call) => call.op === 'DeleteCustomerTier').variables.metafields;
    expect(deleted).toHaveLength(1000);
    expect(deleted.at(-1).ownerId).toBe(customer(5000));
  });

  it('deletes nothing when every holder stays in the tier', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: rows('1', '2'),
      SetCampaignMetafields: stamped,
      CampaignTierHolders: rows('1', '2'),
    });
    expect(await stampTier(admin, vip, queryable)).toEqual({userErrors: []});
    expect(calls.map((call) => call.op)).toEqual(['AudienceRanking', 'SetCampaignMetafields', 'CampaignTierHolders']);
  });

  it('skips the holder query until the tier is queryable', async () => {
    const {admin, calls} = mockAdmin({AudienceRanking: rows('1'), SetCampaignMetafields: stamped});
    expect(await stampTier(admin, vip, {enabled: false, dimension})).toEqual({userErrors: []});
    expect(calls.map((call) => call.op)).toEqual(['AudienceRanking', 'SetCampaignMetafields']);
  });

  it('returns a holder query that does not parse as a warning', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: rows('1'),
      SetCampaignMetafields: stamped,
      CampaignTierHolders: () => ({data: {shopifyqlQuery: {tableData: null, parseErrors: ['Column Not Found']}}}),
    });
    expect(await stampTier(admin, vip, queryable)).toEqual({userErrors: [{message: 'Column Not Found'}]});
    expect(calls.map((call) => call.op)).not.toContain('DeleteCustomerTier');
  });

  it('returns a throttled holder query as a warning', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: rows('1'),
      SetCampaignMetafields: stamped,
      CampaignTierHolders: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect(await stampTier(admin, vip, queryable)).toEqual({userErrors: [{message: 'Throttled'}]});
    expect(calls.map((call) => call.op)).not.toContain('DeleteCustomerTier');
  });

  it('returns a failed clear as a warning', async () => {
    const {admin} = mockAdmin({
      AudienceRanking: rows('3'),
      SetCampaignMetafields: stamped,
      CampaignTierHolders: rows('1', '3'),
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {userErrors: [{message: 'Throttled'}]}}}),
    });
    expect(await stampTier(admin, vip, queryable)).toEqual({userErrors: [{message: 'Throttled'}]});
  });

  it('stamps nobody on a ranking that does not parse', async () => {
    const {admin, calls} = mockAdmin({
      AudienceRanking: () => ({data: {shopifyqlQuery: {tableData: null, parseErrors: ['Bad query']}}}),
    });
    expect(await stampTier(admin, vip, queryable)).toEqual({userErrors: [{message: 'Bad query'}]});
    expect(calls).toHaveLength(1);
  });
});

describe('recordMark', () => {
  it('records the annotation ID beside the ones already stored', async () => {
    const {admin} = mockAdmin({});
    await recordMark(admin, campaign(), 'campaign', 'gid://shopify/AnalyticsAnnotation/4');
    await recordMark(admin, campaign(), 'milestone:2026-09-20', 'gid://shopify/AnalyticsAnnotation/5');
    expect(storedState(4210).markers).toEqual({
      campaign: 'gid://shopify/AnalyticsAnnotation/4',
      'milestone:2026-09-20': 'gid://shopify/AnalyticsAnnotation/5',
    });
  });

  it('deletes the annotation it created when saving its ID fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db.campaignState, 'update').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const {admin, calls} = mockAdmin({
      DeleteCampaignAnnotation: () => ({data: {analyticsAnnotationDelete: {userErrors: []}}}),
    });
    const {userErrors} = await recordMark(admin, campaign(), 'milestone:2026-09-20', 'gid://shopify/AnalyticsAnnotation/5');
    expect(userErrors).toEqual([{message: "Couldn't save the campaign's records. Try again."}]);
    expect(calls.find((call) => call.op === 'DeleteCampaignAnnotation').variables).toEqual({
      id: 'gid://shopify/AnalyticsAnnotation/5',
    });
  });
});

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {campaignMarks, qrHandleFilter, qrHandles, qrLiveOn, touchMarks} from '../app/campaigns';
import {enableDimension, readDimensions} from '../app/dimensions.server';
import {mockAdmin, ops} from './helpers/admin';
import {ALL_FIELDS} from './helpers/campaign';

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

describe('QR code handles', () => {
  it('keeps slug handles and drops unresolved or unsafe ones', () => {
    const qrCodes = [...codes('spring-hat', "x' OR 1=1", 'Bad Case'), {id: 'q9', handle: null}];
    expect(qrHandles(campaign({qrCodes}))).toEqual(['spring-hat']);
  });

  it('builds an IN filter over the handles, or none without codes', () => {
    expect(qrHandleFilter(campaign({qrCodes: codes('a', 'b_2')}))).toBe("utm_campaign IN ('a', 'b_2')");
    expect(qrHandleFilter(campaign())).toBeNull();
    expect(qrHandleFilter(campaign({qrCodes: [{id: 'q', handle: null}]}))).toBeNull();
  });
});

describe('QR code marks', () => {
  const qrMarks = (marks) => marks.filter((mark) => mark.key.startsWith('qr:'));

  it.each([
    [[], []],
    [['a'], ['qr:a']],
    [['a', 'b', 'c'], ['qr:a', 'qr:b', 'qr:c']],
  ])('writes one mark per code for %j', (handles, keys) => {
    const marks = qrMarks(campaignMarks(campaign({qrCodes: codes(...handles)})));
    expect(marks.map((mark) => mark.key)).toEqual(keys);
    for (const mark of marks) expect(mark.date).toBe('2026-09-10');
  });

  it('dates each code on its live day, inside the window', () => {
    const days = ['', '2026-09-25', '2026-11-01', 'soon'];
    const qrCodes = codes('a', 'b', 'c', 'd').map((code, i) => ({...code, liveOn: days[i]}));
    const marks = qrMarks(campaignMarks(campaign({qrCodes})));
    expect(marks.map((mark) => mark.date)).toEqual(['2026-09-10', '2026-09-25', '2026-09-10', '2026-09-10']);
    expect(qrLiveOn(campaign({qrCodes}), 'b')).toBe('2026-09-25');
  });

  it('names each code by its title', () => {
    const marks = qrMarks(campaignMarks(campaign({qrCodes: [{id: 'q', handle: 'hat-front', title: 'Hat front'}]})));
    expect(marks[0].title).toBe('Hat front QR code for Summer launch');
    expect(marks[0].description).toBe("Sales from this code's scans count toward Summer launch.");
  });

  it('leaves QR code marks out of the touches', () => {
    const marks = campaignMarks(campaign({qrCodes: codes('a')}));
    expect(touchMarks({...campaign(), markers: {}, qrCodes: codes('a')}).some((mark) => mark.key.startsWith('qr:'))).toBe(false);
    expect(marks.some((mark) => mark.key === 'qr:a')).toBe(true);
  });
});

describe('dimensions', () => {
  const definitions = (products) => () => ({
    data: {
      products: {nodes: products},
      customers: {nodes: []},
      orders: {nodes: []},
    },
  });
  const reference = {id: 'gid://shopify/MetafieldDefinition/5', key: 'campaign', capabilities: {analyticsQueryable: {eligible: false, enabled: false}}};

  it('skips the probe until the reference exists', async () => {
    const {admin, calls} = mockAdmin({AppMetafieldDefinitions: definitions([])});
    const {product} = await readDimensions(admin, 'gid://shopify/App/7');
    expect(product).toMatchObject({defined: false, enabled: false});
    expect(product.href).toBe('shopify://admin/settings/custom_data/metaobjects/campaign_dashboard_campaign');
    expect(ops(calls)).toEqual(['AppMetafieldDefinitions']);
  });

  it.each([
    [{parseErrors: []}, true],
    [{parseErrors: ["Metafield Column Not Found: Metafield 'x' not found"]}, false],
    [null, false],
  ])('reads the Campaign type toggle from a probe answering %j', async (answer, enabled) => {
    const {admin, calls} = mockAdmin({
      AppMetafieldDefinitions: definitions([reference]),
      CampaignDimensionProbe: () => ({data: {shopifyqlQuery: answer}}),
    });
    const {product} = await readDimensions(admin, 'gid://shopify/App/7');
    expect(product).toMatchObject({defined: true, eligible: true, enabled});
    expect(product.dimension).toBe('product.metafields."app--7--campaign_dashboard".campaign.campaign_id');
    expect(calls[1].op).toBe('CampaignDimensionProbe');
  });

  it('creates the reference validated against the Campaign definition', async () => {
    const {admin, calls} = mockAdmin({
      CampaignDefinition: () => ({data: {campaign: {id: 'gid://shopify/MetaobjectDefinition/2', fieldDefinitions: ALL_FIELDS}}}),
      CreateAnalyticsDimension: () => ({data: {metafieldDefinitionCreate: {createdDefinition: {id: 'x'}, userErrors: []}}}),
    });
    const {product} = await readDimensions(mockAdmin({AppMetafieldDefinitions: definitions([])}).admin, 'gid://shopify/App/7');
    expect(await enableDimension(admin, product)).toEqual([]);
    const {definition} = calls[1].variables;
    expect(definition).toMatchObject({
      key: 'campaign',
      type: 'metaobject_reference',
      ownerType: 'PRODUCT',
      validations: [{name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/2'}],
    });
    expect(definition).not.toHaveProperty('capabilities');
  });

  it('sends the merchant to the admin once the reference exists', async () => {
    const {admin, calls} = mockAdmin({});
    const errors = await enableDimension(admin, {reference: true, defined: true, ownerType: 'PRODUCT'});
    expect(errors[0].message).toMatch(/Turn on analytics for the Campaign type/);
    expect(calls).toEqual([]);
  });
});

describe('QR code sales panel', async () => {
  const {qrCardQuery, qrShape} = await import('../app/panels/dimensions.jsx');
  const withCodes = campaign({qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]});

  it("charts only the campaign's codes", () => {
    expect(qrCardQuery(withCodes)).toContain("WHERE utm_medium = 'qr' AND utm_campaign IN ('hat-front')");
  });

  it('drops rows without sales', () => {
    const rows = [
      {utm_campaign: 'hat-front', campaign_last_non_direct_click_total_sales: '40', campaign_last_non_direct_click_order_count: 2},
      {utm_campaign: 'hat-back', campaign_last_non_direct_click_total_sales: '0', campaign_last_non_direct_click_order_count: 0},
    ];
    const shape = qrShape({
      qrSales: {tableData: {rows}},
      totalSales: '200',
      cell: (row, key) => row[key],
      rate: (part, whole) => (whole ? (part / whole) * 100 : 0),
    });
    expect(shape).toEqual({qrRows: [{code: 'hat-front', sales: 40, orders: 2}], qrTotal: 40, qrShare: 20});
  });
});

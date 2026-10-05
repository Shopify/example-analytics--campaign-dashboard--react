import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {lockStore, mockAdmin, ops} from './helpers/admin';
import {creatorNode, handlesFor, listOf, node} from './helpers/campaign';
import {planned, post, resetTargets, session} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {action: createAction} = await import('../app/routes/app.campaigns._index.jsx');
const {action: qrAction, loader: qrLoader} = await import('../app/routes/app.qrcodes.$id.jsx');
const {loader: qrListLoader} = await import('../app/routes/app.qrcodes._index.jsx');
const {salesTotals} = await import('../app/routes/app.campaigns.$campaignId.jsx');
const {salesQuery} = await import('../app/campaign-queries.server');
const {creatorShape} = await import('../app/panels/dimensions.jsx');
const {campaignFromNode} = await import('../app/campaigns.server');

const upsertedFields = (calls) => calls.find((call) => call.op === 'UpsertQRCode').variables.metaobject.fields;

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

describe('create', () => {
  const creating = () => ({
    CampaignList: listOf([], {value: '4211'}),
    SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: []}}}),
    CreateCampaign: ({metaobject}) => ({
      data: {metaobjectCreate: {metaobject: node({gid: 'g', handle: metaobject.handle, id: 4212}), userErrors: []}},
    }),
  });
  const fields = {title: 'Fall', startDate: '2026-10-01', endDate: '2026-10-31', channels: 'email'};

  it('creates a campaign without any target', async () => {
    const mock = mockAdmin(creating());
    session.admin = mock.raw;
    const response = await createAction({request: post('/app/campaigns', fields)});
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/app/campaigns/4212');
    const saved = Object.fromEntries(mock.calls.find((call) => call.op === 'CreateCampaign').variables.metaobject.fields.map((f) => [f.key, f.value]));
    expect(saved).toMatchObject({revenue_target: '', qr_target: '', status: 'planned'});
  });

  it('rejects a zero amount', async () => {
    const mock = mockAdmin(creating());
    session.admin = mock.raw;
    const result = await createAction({request: post('/app/campaigns', {...fields, qrTarget: '0'})});
    expect(result.problems).toEqual(['QR code target must be greater than 0. Leave it blank for no target.']);
  });

  it('drops a target the form hides', async () => {
    const mock = mockAdmin(creating());
    session.admin = mock.raw;
    await createAction({request: post('/app/campaigns', {...fields, productTarget: '500', audienceTarget: '250'})});
    const saved = Object.fromEntries(mock.calls.find((call) => call.op === 'CreateCampaign').variables.metaobject.fields.map((f) => [f.key, f.value]));
    expect(saved).toMatchObject({product_target: '', audience_target: ''});
  });

  it('upserts each creator in the form and references the entries', async () => {
    const mock = mockAdmin({
      ...creating(),
      CreatorByHandle: () => ({data: {metaobjectByHandle: null}}),
      UpsertCreator: ({handle, metaobject}) => {
        const values = Object.fromEntries(metaobject.fields.map((field) => [field.key, field.value]));
        return {
          data: {
            metaobjectUpsert: {
              metaobject: creatorNode({id: `gid-${handle.handle}`, handle: handle.handle, name: values.name, codes: JSON.parse(values.discount_codes)}),
              userErrors: [],
            },
          },
        };
      },
    });
    session.admin = mock.raw;
    await createAction({request: post('/app/campaigns', {...fields, creatorCodes: 'AVERY10:Avery, juno15:Juno'})});
    const upserts = mock.calls.filter((call) => call.op === 'UpsertCreator');
    expect(upserts.map((call) => call.variables.handle.handle)).toEqual(['creator-avery', 'creator-juno']);
    expect(upserts[1].variables.metaobject.fields).toContainEqual({key: 'discount_codes', value: '["JUNO15"]'});
    const saved = Object.fromEntries(mock.calls.find((call) => call.op === 'CreateCampaign').variables.metaobject.fields.map((f) => [f.key, f.value]));
    expect(saved.creators).toBe('["gid-creator-avery","gid-creator-juno"]');
  });

  it('writes no creator when the form names none', async () => {
    const mock = mockAdmin(creating());
    session.admin = mock.raw;
    await createAction({request: post('/app/campaigns', fields)});
    expect(ops(mock.calls)).not.toContain('UpsertCreator');
  });

  it('stops before the campaign when a creator write fails', async () => {
    const mock = mockAdmin({
      ...creating(),
      CreatorByHandle: () => ({data: {metaobjectByHandle: null}}),
      UpsertCreator: () => ({data: {metaobjectUpsert: {metaobject: null, userErrors: [{message: 'Name is too long'}]}}}),
    });
    session.admin = mock.raw;
    const result = await createAction({request: post('/app/campaigns', {...fields, creatorCodes: 'AVERY10:Avery'})});
    expect(result).toEqual({problems: ['Name is too long']});
    expect(ops(mock.calls)).not.toContain('CreateCampaign');
  });
});

describe('creator revenue', () => {
  const cell = (row, key) => row[key];
  const codeSales = {
    tableData: {
      rows: [
        {discount_code: 'AVERY10', total_sales: '120', orders: '3'},
        {discount_code: 'AVERYSUMMER', total_sales: '30', orders: '1'},
        {discount_code: 'JUNO15', total_sales: '200', orders: '4'},
      ],
    },
  };

  it('maps each code to the creator entry that lists it', () => {
    const campaign = campaignFromNode(
      planned({
        creators: [
          {id: 'a', handle: 'creator-avery', name: 'Avery', codes: ['AVERY10', 'AVERYSUMMER']},
          {id: 'j', handle: 'creator-juno', name: 'Juno', codes: ['JUNO15', 'JUNOFALL']},
        ],
      }),
    );
    const {creatorRows, codeTotal} = creatorShape({codeSales, campaign, touchRows: [], cell});
    expect(creatorRows).toEqual([
      {creator: 'Juno', sales: 200, orders: 4, codes: [{code: 'JUNO15', sales: 200, orders: 4}, {code: 'JUNOFALL', sales: 0, orders: 0}]},
      {creator: 'Avery', sales: 150, orders: 4, codes: [{code: 'AVERY10', sales: 120, orders: 3}, {code: 'AVERYSUMMER', sales: 30, orders: 1}]},
    ]);
    expect(codeTotal).toBe(350);
  });

  it('shows no creator for a campaign without creators', () => {
    expect(creatorShape({codeSales, campaign: campaignFromNode(planned()), touchRows: [], cell}).creatorRows).toEqual([]);
  });
});

describe('QR code save', () => {
  const qrHandlers = (campaigns, extra = {}) => ({
    ...lockStore(),
    CampaignList: listOf(campaigns),
    QRCodeHandles: handlesFor(campaigns),
    UpdateCampaign: () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: []}}}),
    UpsertQRCode: () => ({data: {metaobjectUpsert: {metaobject: {id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}, userErrors: []}}}),
    QRCodeId: () => ({data: {metaobjectByHandle: {id: 'gid://shopify/Metaobject/50'}}}),
    ...extra,
  });
  const form = (campaign) => ({
    title: 'Hat front',
    productId: 'gid://shopify/Product/1',
    productVariantId: 'gid://shopify/ProductVariant/1',
    destination: 'product',
    campaign,
    initialCampaign: '',
    metaobjectId: 'gid://shopify/Metaobject/50',
  });

  it('rejects a campaign the picker never offered', async () => {
    const closed = planned({gid: 'g-closed', status: 'closed'});
    const mock = mockAdmin(qrHandlers([closed]));
    session.admin = mock.raw;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', form('g-closed')), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({errors: {campaign: 'Select a planned campaign.'}});
    expect(ops(mock.calls)).not.toContain('UpsertQRCode');
  });

  it('leaves the campaigns alone when the picker is unchanged', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1'})]));
    session.admin = mock.raw;
    await qrAction({request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g1'}), params: {id: 'hat-front'}}).catch((error) => error);
    expect(ops(mock.calls)).toContain('UpsertQRCode');
    expect(ops(mock.calls)).not.toContain('CampaignList');
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });

  it('keeps a code on an active campaign', async () => {
    const active = planned({gid: 'g-active', status: 'running', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]});
    const mock = mockAdmin(qrHandlers([active, planned({gid: 'g1'})]));
    session.admin = mock.raw;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g-active'}), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({errors: {campaign: 'QR codes move only between planned campaigns.'}});
    expect(ops(mock.calls)).not.toContain('UpsertQRCode');
  });

  it('names the campaign status when a delete is refused', async () => {
    const canceled = planned({gid: 'g-canceled', status: 'canceled', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]});
    const mock = mockAdmin(qrHandlers([canceled]));
    session.admin = mock.raw;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', {action: 'delete'}), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      errors: {campaign: "Only a planned campaign's codes can be deleted. This code's campaign is canceled."},
    });
  });

  it('keeps the code and its campaign when the delete is throttled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const entry = planned({gid: 'g1', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]});
    const mock = mockAdmin(qrHandlers([entry], {DeleteQRCode: () => ({errors: [{message: 'Throttled'}], data: null})}));
    session.admin = mock.raw;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', {action: 'delete'}), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({errors: {campaign: "Couldn't delete the code. Try again."}});
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
    expect(ops(mock.calls)).not.toContain('EndQRCodeMarketingActivity');
  });

  it('deletes the code, then ends its marketing activity', async () => {
    vi.stubEnv('SHOPIFY_APP_URL', 'https://app.test');
    const entry = planned({gid: 'g1', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]});
    const mock = mockAdmin(qrHandlers([entry], {
      DeleteQRCode: () => ({data: {metaobjectDelete: {deletedId: 'gid://shopify/Metaobject/50', userErrors: []}}}),
      EndQRCodeMarketingActivity: () => ({data: {marketingActivityUpsertExternal: {userErrors: []}}}),
    }));
    session.admin = mock.raw;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', {action: 'delete'}), params: {id: 'hat-front'}});
    expect(response.status).toBe(302);
    expect(ops(mock.calls).filter((op) => /Lock|^DeleteQRCode|^EndQRCode/.test(op))).toEqual([
      'CampaignLock',
      'TakeCampaignLock',
      'DeleteQRCode',
      'CampaignLock',
      'ReleaseCampaignLock',
      'EndQRCodeMarketingActivity',
    ]);
    vi.unstubAllEnvs();
  });

  it('rejects a live date outside the campaign', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1'})]));
    session.admin = mock.raw;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', {...form('g1'), liveOn: '2026-10-20'}), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({errors: {liveOn: 'Select a day from Sep 10 to Oct 7.'}});
    expect(ops(mock.calls)).not.toContain('UpsertQRCode');
  });

  it('saves a changed live date on the code, not the campaign', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]})]));
    session.admin = mock.raw;
    await qrAction({
      request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g1', liveOn: '2026-09-20'}),
      params: {id: 'hat-front'},
    }).catch((error) => error);
    expect(upsertedFields(mock.calls)).toContainEqual({key: 'live_on', value: '2026-09-20'});
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });

  it('keeps the stored live date when the form leaves it unchanged', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1'})]));
    session.admin = mock.raw;
    await qrAction({
      request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g1', liveOn: '2026-09-20', initialLiveOn: '2026-09-20'}),
      params: {id: 'hat-front'},
    }).catch((error) => error);
    expect(upsertedFields(mock.calls).map((field) => field.key)).not.toContain('live_on');
  });

  it('clears the live date when the code leaves its campaign', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]})]));
    session.admin = mock.raw;
    await qrAction({
      request: post('/app/qrcodes/hat-front', {...form(''), initialCampaign: 'g1', liveOn: '2026-09-20', initialLiveOn: '2026-09-20'}),
      params: {id: 'hat-front'},
    }).catch((error) => error);
    expect(upsertedFields(mock.calls)).toContainEqual({key: 'live_on', value: ''});
    expect(ops(mock.calls)).toContain('UpdateCampaign');
  });

  it('saves the code and lands on its page when the assignment fails', async () => {
    const mock = mockAdmin(
      qrHandlers([planned({gid: 'g1'})], {
        UpdateCampaign: () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: [{message: 'Throttled'}]}}}),
      }),
    );
    session.admin = mock.raw;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', form('g1')), params: {id: 'hat-front'}}).catch((error) => error);
    expect(ops(mock.calls)).toContain('UpsertQRCode');
    expect(response.headers.get('Location')).toBe('/app/qrcodes/hat-front?campaign=unsaved');
  });
});

describe('QR code pages', () => {
  const qrNode = {
    id: 'gid://shopify/Metaobject/50',
    handle: 'hat-front',
    updatedAt: '2026-09-01T00:00:00Z',
    title: {jsonValue: 'Hat front'},
    product: {jsonValue: null, reference: null},
    productVariant: {reference: null},
    destination: {jsonValue: 'product'},
    scans: {jsonValue: 3},
  };
  const get = (path) => new Request(`https://app.test${path}`);
  beforeEach(() => vi.stubEnv('SHOPIFY_APP_URL', 'https://app.test'));
  afterEach(() => vi.unstubAllEnvs());

  it('picks the campaign a campaign page links with', async () => {
    const entries = [planned({gid: 'g1'}), planned({gid: 'g-closed', id: 4211, status: 'closed'})];
    session.admin = mockAdmin({CampaignList: listOf(entries), QRCodeHandles: handlesFor(entries)}).admin;
    const picked = await qrLoader({request: get('/app/qrcodes/new?campaign=g1'), params: {id: 'new'}});
    const closed = await qrLoader({request: get('/app/qrcodes/new?campaign=g-closed'), params: {id: 'new'}});
    expect(picked.campaign).toBe('g1');
    expect(closed.campaign).toBe('');
  });

  it('lists each code with its campaign', async () => {
    const entries = [planned({gid: 'g1', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]})];
    session.admin = mockAdmin({
      GetQRCodes: () => ({data: {metaobjects: {nodes: [qrNode, {...qrNode, id: 'gid://shopify/Metaobject/51', handle: 'hat-back'}]}}}),
      CampaignList: listOf(entries),
      QRCodeHandles: handlesFor(entries),
    }).admin;
    const {qrCodes} = await qrListLoader({request: get('/app/qrcodes')});
    expect(qrCodes.map((qrCode) => [qrCode.handle, qrCode.campaign])).toEqual([
      ['hat-front', {id: 4210, title: 'Summer launch'}],
      ['hat-back', null],
    ]);
  });
});

describe('sales totals', () => {
  const row = {
    total_sales__totals: '202192.75',
    comparison_total_sales__previous_period__totals: '90726.9',
    percent_change_total_sales__previous_period__totals: '122.858',
  };

  it('asks Shopify for the percent change', () => {
    expect(salesQuery({startDate: '2026-09-01', endDate: '2026-09-30'})).toContain('WITH TOTALS, PERCENT_CHANGE');
  });

  it('reads the percent from the PERCENT_CHANGE column', () => {
    expect(salesTotals([row])).toEqual({totalSales: '202192.75', percentChange: 122.858});
    expect(salesTotals([{...row, percent_change_total_sales__previous_period__totals: '-5'}]).percentChange).toBe(-5);
  });

  it('has no percent without the column or a previous total', () => {
    const {percent_change_total_sales__previous_period__totals: _, ...noColumn} = row;
    expect(salesTotals([noColumn]).percentChange).toBeNull();
    expect(salesTotals([{...row, comparison_total_sales__previous_period__totals: '0'}]).percentChange).toBeNull();
    expect(salesTotals([])).toEqual({totalSales: '0', percentChange: null});
  });
});

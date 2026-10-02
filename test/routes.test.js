import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mockAdmin, ops} from './helpers/admin';
import {handlesFor, listOf, node} from './helpers/campaign';
import {planned, post, resetTargets, session} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {action: createAction} = await import('../app/routes/app.campaigns._index.jsx');
const {action: qrAction, loader: qrLoader} = await import('../app/routes/app.qrcodes.$id.jsx');
const {loader: qrListLoader} = await import('../app/routes/app.qrcodes._index.jsx');

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
    session.admin = mock.admin;
    const response = await createAction({request: post('/app/campaigns', fields)});
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/app/campaigns/4212');
    const saved = Object.fromEntries(mock.calls.find((call) => call.op === 'CreateCampaign').variables.metaobject.fields.map((f) => [f.key, f.value]));
    expect(saved).toMatchObject({revenue_target: '', qr_target: '', status: 'planned'});
  });

  it('rejects a zero amount', async () => {
    const mock = mockAdmin(creating());
    session.admin = mock.admin;
    const result = await createAction({request: post('/app/campaigns', {...fields, qrTarget: '0'})});
    expect(result.problems).toEqual(['QR code target must be greater than 0. Leave it blank for no target.']);
  });

  it('drops a target the form hides', async () => {
    const mock = mockAdmin(creating());
    session.admin = mock.admin;
    await createAction({request: post('/app/campaigns', {...fields, productTarget: '500', audienceTarget: '250'})});
    const saved = Object.fromEntries(mock.calls.find((call) => call.op === 'CreateCampaign').variables.metaobject.fields.map((f) => [f.key, f.value]));
    expect(saved).toMatchObject({product_target: '', audience_target: ''});
  });
});

describe('QR code save', () => {
  const qrHandlers = (campaigns, extra = {}) => ({
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
    session.admin = mock.admin;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', form('g-closed')), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({errors: {campaign: 'Select a planned campaign.'}});
    expect(ops(mock.calls)).not.toContain('UpsertQRCode');
  });

  it('leaves the campaigns alone when the picker is unchanged', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1'})]));
    session.admin = mock.admin;
    await qrAction({request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g1'}), params: {id: 'hat-front'}}).catch((error) => error);
    expect(ops(mock.calls)).toContain('UpsertQRCode');
    expect(ops(mock.calls)).not.toContain('CampaignList');
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });

  it('keeps a code on an active campaign', async () => {
    const active = planned({gid: 'g-active', status: 'running', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]});
    const mock = mockAdmin(qrHandlers([active, planned({gid: 'g1'})]));
    session.admin = mock.admin;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g-active'}), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({errors: {campaign: 'QR codes move only between planned campaigns.'}});
    expect(ops(mock.calls)).not.toContain('UpsertQRCode');
  });

  it('rejects a live date outside the campaign', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1'})]));
    session.admin = mock.admin;
    const response = await qrAction({request: post('/app/qrcodes/hat-front', {...form('g1'), liveOn: '2026-10-20'}), params: {id: 'hat-front'}});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({errors: {liveOn: 'Select a day from Sep 10 to Oct 7.'}});
    expect(ops(mock.calls)).not.toContain('UpsertQRCode');
  });

  it('saves a changed live date on the code, not the campaign', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]})]));
    session.admin = mock.admin;
    await qrAction({
      request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g1', liveOn: '2026-09-20'}),
      params: {id: 'hat-front'},
    }).catch((error) => error);
    expect(upsertedFields(mock.calls)).toContainEqual({key: 'live_on', value: '2026-09-20'});
    expect(ops(mock.calls)).not.toContain('UpdateCampaign');
  });

  it('keeps the stored live date when the form leaves it unchanged', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1'})]));
    session.admin = mock.admin;
    await qrAction({
      request: post('/app/qrcodes/hat-front', {...form('g1'), initialCampaign: 'g1', liveOn: '2026-09-20', initialLiveOn: '2026-09-20'}),
      params: {id: 'hat-front'},
    }).catch((error) => error);
    expect(upsertedFields(mock.calls).map((field) => field.key)).not.toContain('live_on');
  });

  it('clears the live date when the code leaves its campaign', async () => {
    const mock = mockAdmin(qrHandlers([planned({gid: 'g1', qrCodes: [{id: 'gid://shopify/Metaobject/50', handle: 'hat-front'}]})]));
    session.admin = mock.admin;
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
    session.admin = mock.admin;
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

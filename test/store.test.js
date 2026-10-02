import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  FIRST_CAMPAIGN_ID,
  assignQRCode,
  campaignFields,
  campaignFromNode,
  createCampaign,
  ensureCampaign,
  ensureDefinition,
  forgetCustomer,
  nextCampaignId,
  readCampaigns,
  rememberMarkers,
  updateCampaign,
} from '../app/campaigns.server';
import {mockAdmin, ops} from './helpers/admin';
import {ALL_FIELDS, listOf, node, qrCodeHandles} from './helpers/campaign';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('campaign IDs', () => {
  it('starts at the first ID', () => {
    expect(nextCampaignId([], null)).toBe(FIRST_CAMPAIGN_ID);
  });
  it('counts past the high-water mark after the highest campaign is deleted', () => {
    expect(nextCampaignId([{id: 4210}], 4212)).toBe(4213);
  });
  it('counts past a stored ID above the mark', () => {
    expect(nextCampaignId([{id: 4215}], 4212)).toBe(4216);
  });
});

describe('field mapping', () => {
  it('round-trips a campaign through the entry fields', () => {
    const campaign = campaignFromNode(
      node({
        id: 4210,
        title: 'Summer',
        startDate: '2026-09-10',
        endDate: '2026-10-07',
        channels: ['email'],
        products: [{id: 'gid://shopify/Product/1', title: 'Hat'}],
        qrCodes: [{id: 'gid://shopify/Metaobject/9', handle: 'summer-hat'}],
        audience: 'vip',
        creatorCodes: [{code: 'A', creator: 'B'}],
        revenueTarget: '100.0',
        status: 'running',
        markers: {campaign: 'gid://shopify/AnalyticsAnnotation/1'},
        targets: {store: 'gid://shopify/AnalyticsTarget/2'},
        sentEvents: 9,
      }),
    );
    expect(campaign).toMatchObject({
      gid: 'gid://shopify/Metaobject/1',
      handle: 'campaign-4210',
      id: 4210,
      products: [{id: 'gid://shopify/Product/1', title: 'Hat'}],
      qrCodes: [{id: 'gid://shopify/Metaobject/9', handle: null, title: ''}],
      revenueTarget: '100.0',
      productTarget: '',
      qrTarget: '',
      targets: {store: 'gid://shopify/AnalyticsTarget/2'},
      sentEvents: 9,
    });
  });

  it('defaults every field a merchant cleared in the admin', () => {
    const campaign = campaignFromNode({id: 'gid://x', handle: 'h', fields: [{key: 'campaign_id', jsonValue: 4300}]});
    expect(campaign).toMatchObject({
      id: 4300,
      channels: [],
      products: [],
      qrCodes: [],
      audience: 'everyone',
      status: 'planned',
      markers: {},
      targets: {},
      sentEvents: null,
    });
  });

  it('drops a product whose reference no longer resolves', () => {
    const entry = node({id: 4210, products: []});
    entry.fields.push({key: 'products', jsonValue: ['gid://shopify/Product/404']});
    expect(campaignFromNode(entry).products).toEqual([]);
  });

  it('looks up QR code handles and drops a deleted code', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([node({id: 4210, qrCodes: [{id: 'gid://shopify/Metaobject/901'}, {id: 'gid://shopify/Metaobject/909'}, {id: 'not-a-gid'}]})]),
      QRCodeHandles: qrCodeHandles([{id: 'gid://shopify/Metaobject/901', handle: 'summer-hat', title: {value: 'Summer hat'}}]),
    });
    const {campaigns, failed} = await readCampaigns(admin);
    expect(failed).toEqual([]);
    expect(campaigns[0].qrCodes).toEqual([{id: 'gid://shopify/Metaobject/901', handle: 'summer-hat', title: 'Summer hat', liveOn: ''}]);
    expect(calls[1].variables).toEqual({ids: ['gid://shopify/Metaobject/901', 'gid://shopify/Metaobject/909']});
  });

  it('skips the handle lookup without QR codes', async () => {
    const {admin, calls} = mockAdmin({CampaignList: listOf([node({id: 4210})])});
    await readCampaigns(admin);
    expect(ops(calls)).toEqual(['CampaignList']);
  });

  it('writes only the keys in the change, and an empty value clears', () => {
    expect(campaignFields({revenueTarget: '', qrCodes: [{id: 'gid://shopify/Metaobject/901'}], markers: {a: 'b'}})).toEqual([
      {key: 'qr_code_ids', value: '["gid://shopify/Metaobject/901"]'},
      {key: 'revenue_target', value: ''},
      {key: 'markers', value: '{"a":"b"}'},
    ]);
  });
});

describe('ensureDefinition', () => {
  it('returns the stored definition without creating one', async () => {
    const {admin, calls} = mockAdmin({
      CampaignDefinition: () => ({data: {campaign: {id: 'def', fieldDefinitions: ALL_FIELDS}}}),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'def', userErrors: []});
    expect(ops(calls)).toEqual(['CampaignDefinition']);
  });

  it('adds a field the stored definition lacks', async () => {
    const {admin, calls} = mockAdmin({
      CampaignDefinition: () => ({data: {campaign: {id: 'def', fieldDefinitions: [{key: 'title'}]}}}),
      AddCampaignFields: () => ({data: {metaobjectDefinitionUpdate: {metaobjectDefinition: {id: 'def'}, userErrors: []}}}),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'def', userErrors: []});
    const keys = calls[1].variables.definition.fieldDefinitions.map(({create}) => create.key);
    expect(keys).toContain('qr_code_ids');
    expect(keys).not.toContain('title');
  });

  it('stores QR code IDs as text that an uninstall leaves in place', async () => {
    const {admin, calls} = mockAdmin({
      CampaignDefinition: () => ({data: {campaign: null}}),
      CreateCampaignDefinition: () => ({
        data: {metaobjectDefinitionCreate: {metaobjectDefinition: {id: 'def'}, userErrors: []}},
      }),
    });
    expect((await ensureDefinition(admin)).definitionId).toBe('def');
    const {definition} = calls[1].variables;
    expect(definition.fieldDefinitions.find((field) => field.key === 'qr_code_ids')).toMatchObject({
      type: 'list.single_line_text_field',
      validations: [{name: 'list.max', value: '50'}],
    });
    expect(definition.fieldDefinitions.every((field) => !('field' in field))).toBe(true);
  });

  it('finds the definition a racing request created', async () => {
    let reads = 0;
    const {admin} = mockAdmin({
      CampaignDefinition: () => ({
        data: {campaign: reads++ ? {id: 'winner', fieldDefinitions: ALL_FIELDS} : null},
      }),
      CreateCampaignDefinition: () => ({
        data: {metaobjectDefinitionCreate: {metaobjectDefinition: null, userErrors: [{message: 'Type taken'}]}},
      }),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'winner', userErrors: []});
  });
});

describe('ensureCampaign', () => {
  const definition = () => ({data: {campaign: {id: 'def', fieldDefinitions: ALL_FIELDS}}});

  it('seeds two campaigns and spends both IDs on a new store', async () => {
    const {admin, calls} = mockAdmin({
      CampaignDefinition: definition,
      CampaignList: listOf([]),
      UpsertCampaign: ({handle}) => ({
        data: {
          metaobjectUpsert: {
            metaobject: node({gid: `gid-${handle.handle}`, handle: handle.handle, id: Number(handle.handle.split('-')[1])}),
            userErrors: [],
          },
        },
      }),
      SetCampaignMetafields: () => ({data: {metafieldsSet: {metafields: [], userErrors: []}}}),
    });
    const result = await ensureCampaign(admin);
    expect(result.userErrors).toEqual([]);
    expect(result.campaigns.map((campaign) => campaign.id)).toEqual([4210, 4211]);
    const upserts = calls.filter((call) => call.op === 'UpsertCampaign');
    expect(upserts.map((call) => call.variables.handle.handle)).toEqual(['campaign-4210', 'campaign-4211']);
    expect(calls.at(-1).variables.metafields[0]).toMatchObject({key: 'last_campaign_id', value: '4211'});
  });

  it('skips the seed once a high-water mark exists', async () => {
    const {admin, calls} = mockAdmin({
      CampaignDefinition: definition,
      CampaignList: listOf([], {value: '4211'}),
    });
    const result = await ensureCampaign(admin);
    expect(result.campaigns).toEqual([]);
    expect(ops(calls)).toEqual(['CampaignDefinition', 'CampaignList']);
  });

  it('refuses to seed on a failed read', async () => {
    const {admin, calls} = mockAdmin({
      CampaignDefinition: definition,
      CampaignList: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect((await ensureCampaign(admin)).userErrors).toEqual([{message: 'Throttled'}]);
    expect(ops(calls)).not.toContain('UpsertCampaign');
  });
});

describe('createCampaign', () => {
  const setMark = () => ({data: {metafieldsSet: {metafields: [], userErrors: []}}});

  it('spends the next ID and creates the entry under its handle', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([node({id: 4210})], {value: '4212'}),
      SetCampaignMetafields: setMark,
      CreateCampaign: ({metaobject}) => ({
        data: {metaobjectCreate: {metaobject: node({gid: 'new', handle: metaobject.handle, id: 4213}), userErrors: []}},
      }),
    });
    const {campaign, userErrors} = await createCampaign(admin, {title: 'Fall'});
    expect(userErrors).toEqual([]);
    expect(campaign.id).toBe(4213);
    expect(ops(calls)).toEqual(['CampaignList', 'SetCampaignMetafields', 'CreateCampaign']);
    const fields = Object.fromEntries(calls[2].variables.metaobject.fields.map((field) => [field.key, field.value]));
    expect(fields).toMatchObject({campaign_id: '4213', status: 'planned', audience: 'everyone', title: 'Fall'});
  });

  it('deletes a suffixed entry and retries with the next ID', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([], {value: '4211'}),
      SetCampaignMetafields: setMark,
      CreateCampaign: ({metaobject}) => {
        const taken = metaobject.handle === 'campaign-4212';
        return {
          data: {
            metaobjectCreate: {
              metaobject: node({gid: `gid-${metaobject.handle}`, handle: taken ? 'campaign-4212-1' : metaobject.handle, id: 0}),
              userErrors: [],
            },
          },
        };
      },
      DeleteCampaign: () => ({data: {metaobjectDelete: {deletedId: 'x', userErrors: []}}}),
    });
    const {campaign} = await createCampaign(admin, {title: 'Race'});
    expect(campaign.handle).toBe('campaign-4213');
    expect(calls.find((call) => call.op === 'DeleteCampaign').variables.id).toBe('gid-campaign-4212');
    expect(calls.filter((call) => call.op === 'SetCampaignMetafields').map((call) => call.variables.metafields[0].value)).toEqual(['4212', '4213']);
  });

  it('hands out no ID on a failed read', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect((await createCampaign(admin, {})).userErrors).toEqual([{message: 'Throttled'}]);
    expect(ops(calls)).toEqual(['CampaignList']);
  });

  it('stops when the ID mark fails to save', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([]),
      SetCampaignMetafields: () => ({data: {metafieldsSet: {userErrors: [{message: 'Nope'}]}}}),
    });
    expect((await createCampaign(admin, {})).userErrors).toEqual([{message: 'Nope'}]);
    expect(ops(calls)).not.toContain('CreateCampaign');
  });
});

describe('entry writes', () => {
  const updated = () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: []}}});

  it('refuses a write when someone changed the campaign since it was read', async () => {
    const campaign = {gid: 'g1', updatedAt: '2026-09-30T10:00:00Z'};
    const {admin, calls} = mockAdmin({
      CampaignVersion: () => ({data: {metaobject: {updatedAt: '2026-09-30T10:05:00Z'}}}),
    });
    const {userErrors} = await updateCampaign(admin, campaign, {status: 'running'});
    expect(userErrors[0].code).toBe('STALE');
    expect(ops(calls)).toEqual(['CampaignVersion']);
  });

  it('carries the new version to the next write in the same action', async () => {
    const campaign = {gid: 'g1', updatedAt: '2026-09-30T10:00:00Z'};
    const {admin} = mockAdmin({
      CampaignVersion: () => ({data: {metaobject: {updatedAt: campaign.updatedAt}}}),
      UpdateCampaign: () => ({
        data: {metaobjectUpdate: {metaobject: node({id: 4210, updatedAt: '2026-09-30T10:01:00Z'}), userErrors: []}},
      }),
    });
    await updateCampaign(admin, campaign, {status: 'running'});
    expect(campaign.updatedAt).toBe('2026-09-30T10:01:00Z');
  });

  it('merges new marker IDs into the stored ones', async () => {
    const stale = campaignFromNode(node({id: 4210, markers: {}}));
    const {admin, calls} = mockAdmin({
      CampaignById: () => ({data: {metaobject: node({id: 4210, markers: {campaign: 'a1'}})}}),
      UpdateCampaign: updated,
    });
    await rememberMarkers(admin, stale, {launch: 'a2'});
    expect(calls[1].variables).toEqual({
      id: 'gid://shopify/Metaobject/1',
      metaobject: {fields: [{key: 'markers', value: '{"campaign":"a1","launch":"a2"}'}]},
    });
  });

  it('deletes a redacted customer\'s tier metafield', async () => {
    const {admin, calls} = mockAdmin({
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {deletedMetafields: [{key: 'tier'}], userErrors: []}}}),
    });
    expect(await forgetCustomer(admin, 'gid://shopify/Customer/5')).toEqual([]);
    expect(calls[0].variables.metafields).toEqual([
      {ownerId: 'gid://shopify/Customer/5', namespace: '$app:campaign_dashboard', key: 'tier'},
    ]);
  });

  it('adds a QR code to its new campaign, then drops it from every other', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([
        node({gid: 'g1', id: 4210, qrCodes: [{id: 'gid://shopify/Metaobject/901', handle: 'a'}]}),
        node({gid: 'g2', id: 4211, qrCodes: [{id: 'gid://shopify/Metaobject/902', handle: 'b'}]}),
        node({gid: 'g3', id: 4212}),
      ]),
      QRCodeHandles: qrCodeHandles([{id: 'gid://shopify/Metaobject/901', handle: 'a'}, {id: 'gid://shopify/Metaobject/902', handle: 'b'}]),
      UpdateCampaign: updated,
    });
    await assignQRCode(admin, 'gid://shopify/Metaobject/901', 'g2');
    const updates = calls.filter((call) => call.op === 'UpdateCampaign').map((call) => call.variables);
    expect(updates).toEqual([
      {id: 'g2', metaobject: {fields: [{key: 'qr_code_ids', value: '["gid://shopify/Metaobject/902","gid://shopify/Metaobject/901"]'}]}},
      {id: 'g1', metaobject: {fields: [{key: 'qr_code_ids', value: '[]'}]}},
    ]);
  });

  it('leaves the campaigns alone when the code stays put', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210, qrCodes: [{id: 'gid://shopify/Metaobject/901', handle: 'a'}]})]),
      QRCodeHandles: qrCodeHandles([{id: 'gid://shopify/Metaobject/901', handle: 'a'}]),
      UpdateCampaign: updated,
    });
    await assignQRCode(admin, 'gid://shopify/Metaobject/901', 'g1');
    expect(calls.filter((call) => call.op === 'UpdateCampaign')).toHaveLength(0);
  });

  it("reads each code's live date from the code", async () => {
    const {admin} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210, qrCodes: [{id: 'gid://shopify/Metaobject/901', handle: 'a'}]})]),
      QRCodeHandles: qrCodeHandles([{id: 'gid://shopify/Metaobject/901', handle: 'a', liveOn: {value: '2026-09-20'}}]),
    });
    const {campaigns} = await readCampaigns(admin);
    expect(campaigns[0].qrCodes).toEqual([{id: 'gid://shopify/Metaobject/901', handle: 'a', title: '', liveOn: '2026-09-20'}]);
  });

  it('unassigns a QR code with no campaign', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210, qrCodes: [{id: 'gid://shopify/Metaobject/901', handle: 'a'}]})]),
      QRCodeHandles: qrCodeHandles([{id: 'gid://shopify/Metaobject/901', handle: 'a'}]),
      UpdateCampaign: updated,
    });
    await assignQRCode(admin, 'gid://shopify/Metaobject/901', null);
    expect(calls.filter((call) => call.op === 'UpdateCampaign')).toHaveLength(1);
  });
});

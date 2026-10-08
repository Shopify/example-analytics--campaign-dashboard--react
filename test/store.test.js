import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  FIRST_CAMPAIGN_ID,
  campaignFields,
  campaignFromNode,
  createCampaign,
  creatorFromNode,
  ensureCampaign,
  ensureDefinition,
  forgetCustomer,
  lockCampaign,
  lockQRCodeMove,
  campaignIdFloor,
  readCampaigns,
  rememberMarkers,
  updateCampaign,
  upsertCreators,
  withState,
} from '../app/campaigns.server';
import {mockAdmin, ops} from './helpers/admin';
import {ALL_FIELDS, creatorNode, listOf, node, objectDefinitions, qrCodeList, qrCodeNode} from './helpers/campaign';
import {SHOP, db, seedState, storedState, tablesOf} from './helpers/db';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('campaign IDs', () => {
  it('floors a store without campaigns below the first ID', () => {
    expect(campaignIdFloor([])).toBe(FIRST_CAMPAIGN_ID - 1);
  });
  it('floors at the highest stored ID', () => {
    expect(campaignIdFloor([{id: 4215}, {id: 4210}])).toBe(4215);
  });
});

describe('field mapping', () => {
  it('round-trips a campaign through the entry fields', async () => {
    const {admin} = mockAdmin({
      CampaignList: listOf([
        node({
        id: 4210,
        title: 'Summer',
        startDate: '2026-09-10',
        endDate: '2026-10-07',
        channels: ['email'],
        products: [{id: 'gid://shopify/Product/1', title: 'Hat'}],
        audience: 'vip',
        revenueTarget: '100.0',
        status: 'running',
        markers: {campaign: 'gid://shopify/AnalyticsAnnotation/1'},
        targets: {store: 'gid://shopify/AnalyticsTarget/2'},
        sentEvents: 9,
        }),
      ]),
    });
    const {campaigns: [campaign]} = await readCampaigns(admin, SHOP);
    expect(campaign).toMatchObject({
      gid: 'gid://shopify/Metaobject/1',
      handle: 'campaign-4210',
      id: 4210,
      products: [{id: 'gid://shopify/Product/1', title: 'Hat'}],
      qrCodes: [],
      revenueTarget: '100.0',
      productTarget: '',
      qrTarget: '',
      targets: {store: 'gid://shopify/AnalyticsTarget/2'},
      sentEvents: 9,
    });
  });

  it('defaults every field a merchant cleared in the admin', () => {
    const entry = {id: 'gid://x', handle: 'h', fields: [{key: 'campaign_id', jsonValue: 4300}]};
    const campaign = withState(campaignFromNode(entry), SHOP, null);
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

  it("ignores records left by a deleted entry that held the campaign's ID", async () => {
    seedState({campaignId: 4210, gid: 'gid://shopify/Metaobject/old', markers: {campaign: 'a1'}, sentEvents: 3});
    const {admin} = mockAdmin({CampaignList: listOf([node({id: 4210})])});
    const {campaigns} = await readCampaigns(admin, SHOP);
    expect(campaigns[0]).toMatchObject({markers: {}, targets: {}, sentEvents: null});
  });

  it("fails the read when the app's records fail to read", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db.campaignState, 'findMany').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const {admin} = mockAdmin({CampaignList: listOf([node({id: 4210})])});
    expect(await readCampaigns(admin, SHOP)).toMatchObject({
      failed: [{message: "Couldn't read the app's campaign records. Try again."}],
      campaigns: [],
    });
  });

  it('drops a product whose reference no longer resolves', () => {
    const entry = node({id: 4210, products: []});
    entry.fields.push({key: 'products', jsonValue: ['gid://shopify/Product/404']});
    expect(campaignFromNode(entry).products).toEqual([]);
  });

  it("groups QR codes by each code's campaign field and leaves an unknown campaign out", async () => {
    const code = (id, campaign) => qrCodeNode({id: `gid://shopify/Metaobject/${id}`, handle: `code-${id}`, campaign});
    const {admin} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210}), node({gid: 'g2', id: 4211})]),
      CampaignQRCodes: qrCodeList([
        {...code(901, 'g2'), title: {value: 'Summer hat'}},
        code(902, 'g1'),
        code(903, 'g2'),
        code(904, 'gid://shopify/Metaobject/404'),
        code(905, null),
      ]),
    });
    const {campaigns, failed} = await readCampaigns(admin, SHOP);
    expect(failed).toEqual([]);
    expect(campaigns.map((campaign) => campaign.qrCodes.map((qrCode) => qrCode.handle))).toEqual([
      ['code-902'],
      ['code-901', 'code-903'],
    ]);
    expect(campaigns[1].qrCodes[0]).toEqual({id: 'gid://shopify/Metaobject/901', handle: 'code-901', title: 'Summer hat', liveOn: ''});
  });

  it('reads every page of QR codes', async () => {
    const page = (nodes, endCursor) => ({data: {metaobjects: {nodes, pageInfo: {hasNextPage: Boolean(endCursor), endCursor}}}});
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210})]),
      CampaignQRCodes: ({after}) =>
        after
          ? page([qrCodeNode({id: 'q2', handle: 'b', campaign: 'g1'})], null)
          : page([qrCodeNode({id: 'q1', handle: 'a', campaign: 'g1'})], 'c1'),
    });
    const {campaigns} = await readCampaigns(admin, SHOP);
    expect(campaigns[0].qrCodes.map((qrCode) => qrCode.id)).toEqual(['q1', 'q2']);
    expect(calls.filter((call) => call.op === 'CampaignQRCodes').map((call) => call.variables)).toEqual([{after: null}, {after: 'c1'}]);
  });

  it('fails the read past 20 pages of QR codes', async () => {
    const {admin} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210})]),
      CampaignQRCodes: () => ({data: {metaobjects: {nodes: [], pageInfo: {hasNextPage: true, endCursor: 'more'}}}}),
    });
    expect(await readCampaigns(admin, SHOP)).toMatchObject({
      failed: [{message: 'This store has more than 5,000 QR codes. The campaign dashboard reads up to 5,000.'}],
      campaigns: [],
    });
  });

  it('fails the read past 20 pages of campaigns', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: () => {
        const body = listOf([node({gid: 'g1', id: 4210})])();
        body.data.metaobjects.pageInfo = {hasNextPage: true, endCursor: 'more'};
        return body;
      },
    });
    expect((await readCampaigns(admin, SHOP)).failed).toEqual([
      {message: 'This store has more than 5,000 campaigns. The campaign dashboard reads up to 5,000.'},
    ]);
    expect(ops(calls).filter((op) => op === 'CampaignList')).toHaveLength(20);
  });

  it('fails the read when the QR code list fails', async () => {
    const {admin} = mockAdmin({
      CampaignList: listOf([node({id: 4210})]),
      CampaignQRCodes: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect(await readCampaigns(admin, SHOP)).toMatchObject({failed: [{message: 'Throttled'}], campaigns: []});
  });

  it('skips the QR code list without campaigns', async () => {
    const {admin, calls} = mockAdmin({CampaignList: listOf([])});
    await readCampaigns(admin, SHOP);
    expect(ops(calls)).toEqual(['CampaignList']);
  });

  it('writes only the keys in the change, and an empty value clears', () => {
    expect(campaignFields({revenueTarget: '', products: [{id: 'gid://shopify/Product/1'}], markers: {a: 'b'}})).toEqual([
      {key: 'products', value: '["gid://shopify/Product/1"]'},
      {key: 'revenue_target', value: ''},
    ]);
  });
});

describe('ensureDefinition', () => {
  const created = (id) => () => ({
    data: {metaobjectDefinitionCreate: {metaobjectDefinition: {id}, userErrors: []}},
  });

  it('returns the stored definition without creating one', async () => {
    const {admin, calls} = mockAdmin({ObjectDefinition: objectDefinitions()});
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'def', userErrors: []});
    expect(ops(calls)).toEqual(['ObjectDefinition', 'ObjectDefinition']);
  });

  it('reads and creates the Creator type before the Campaign type', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: objectDefinitions({creator: null, campaign: null}),
      CreateObjectDefinition: ({definition}) =>
        created(definition.type === 'campaign_dashboard_creator' ? 'creator-def' : 'def')(),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'def', userErrors: []});
    expect(calls.map((call) => [call.op, call.variables.type ?? call.variables.definition.type])).toEqual([
      ['ObjectDefinition', 'campaign_dashboard_creator'],
      ['CreateObjectDefinition', 'campaign_dashboard_creator'],
      ['ObjectDefinition', 'campaign_dashboard_campaign'],
      ['CreateObjectDefinition', 'campaign_dashboard_campaign'],
    ]);
    const creator = calls[1].variables.definition;
    expect(creator).toMatchObject({displayNameKey: 'name'});
    expect(creator.fieldDefinitions.map((field) => field.key)).toEqual(['name', 'discount_codes']);
    const campaign = calls[3].variables.definition;
    expect(campaign.fieldDefinitions.find((field) => field.key === 'creators')).toEqual({
      key: 'creators',
      name: 'Creators',
      type: 'list.metaobject_reference',
      description: 'Creators who share a discount code for this campaign.',
      validations: [
        {name: 'list.max', value: '50'},
        {name: 'metaobject_definition_id', value: 'creator-def'},
      ],
    });
  });

  it('stops before the Campaign type when the Creator type fails', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: null, userErrors: [{message: 'Throttled'}]});
    expect(calls).toHaveLength(1);
  });

  it('adds the creators field to a stored Campaign definition', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: objectDefinitions({
        campaign: {id: 'def', fieldDefinitions: [{key: 'title'}, {key: 'creator_codes'}]},
      }),
      AddObjectFields: () => ({data: {metaobjectDefinitionUpdate: {metaobjectDefinition: {id: 'def'}, userErrors: []}}}),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'def', userErrors: []});
    const added = calls.find((call) => call.op === 'AddObjectFields');
    expect(added.variables.id).toBe('def');
    const fields = added.variables.definition.fieldDefinitions.map(({create}) => create);
    expect(fields.map((field) => field.key)).toContain('creators');
    expect(fields.map((field) => field.key)).not.toContain('title');
    expect(fields.find((field) => field.key === 'creators').validations).toEqual([
      {name: 'list.max', value: '50'},
      {name: 'metaobject_definition_id', value: 'creator-def'},
    ]);
  });

  it('accepts a field that a racing request added first', async () => {
    let reads = 0;
    const {admin} = mockAdmin({
      ObjectDefinition: ({type}) =>
        type === 'campaign_dashboard_creator'
          ? objectDefinitions()({type})
          : {data: {definition: {id: 'def', fieldDefinitions: reads++ ? ALL_FIELDS : [{key: 'title'}]}}},
      AddObjectFields: () => ({data: {metaobjectDefinitionUpdate: {metaobjectDefinition: null, userErrors: [{message: 'Key is in use'}]}}}),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'def', userErrors: []});
  });

  it('fails a field add that the re-read still finds missing', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: objectDefinitions({campaign: {id: 'def', fieldDefinitions: [{key: 'title'}]}}),
      AddObjectFields: () => ({data: {metaobjectDefinitionUpdate: {metaobjectDefinition: null, userErrors: [{message: 'Invalid field'}]}}}),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: null, userErrors: [{message: 'Invalid field'}]});
    expect(ops(calls)).toEqual(['ObjectDefinition', 'ObjectDefinition', 'AddObjectFields', 'ObjectDefinition']);
  });

  it('leaves the QR codes off the Campaign definition', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: objectDefinitions({campaign: null}),
      CreateObjectDefinition: created('def'),
    });
    expect((await ensureDefinition(admin)).definitionId).toBe('def');
    const {definition} = calls.find((call) => call.op === 'CreateObjectDefinition').variables;
    expect(definition.fieldDefinitions.filter((field) => /qr_code/.test(field.key))).toEqual([]);
    expect(campaignFields({qrCodes: [{id: 'gid://shopify/Metaobject/901'}]})).toEqual([]);
    expect(definition.fieldDefinitions.every((field) => !('field' in field))).toBe(true);
  });

  it('finds the definition a racing request created', async () => {
    let reads = 0;
    const {admin} = mockAdmin({
      ObjectDefinition: ({type}) =>
        type === 'campaign_dashboard_creator'
          ? objectDefinitions()({type})
          : {data: {definition: reads++ ? {id: 'winner', fieldDefinitions: ALL_FIELDS} : null}},
      CreateObjectDefinition: () => ({
        data: {metaobjectDefinitionCreate: {metaobjectDefinition: null, userErrors: [{message: 'Type taken'}]}},
      }),
    });
    expect(await ensureDefinition(admin)).toEqual({definitionId: 'winner', userErrors: []});
  });
});

describe('creators', () => {
  const avery = {id: 'gid://shopify/Metaobject/70', handle: 'creator-avery', name: 'Avery', codes: ['AVERY10']};
  const creatorStore = (stored = {}) => {
    const entries = new Map(Object.entries(stored));
    return {
      entries,
      CreatorByHandle: ({handle}) => ({
        data: {metaobjectByHandle: entries.has(handle.handle) ? creatorNode(entries.get(handle.handle)) : null},
      }),
      UpsertCreator: ({handle, metaobject}) => {
        const values = Object.fromEntries(metaobject.fields.map((field) => [field.key, field.value]));
        const entry = {
          id: entries.get(handle.handle)?.id ?? `gid://shopify/Metaobject/${entries.size + 70}`,
          handle: handle.handle,
          name: values.name,
          codes: JSON.parse(values.discount_codes),
        };
        entries.set(handle.handle, entry);
        return {data: {metaobjectUpsert: {metaobject: creatorNode(entry), userErrors: []}}};
      },
    };
  };

  it('upserts one entry per creator on a handle from the name', async () => {
    const store = creatorStore();
    const {admin, calls} = mockAdmin(store);
    const {creators, userErrors} = await upsertCreators(admin, [
      {code: 'AVERY10', creator: 'Avery'},
      {code: 'AVERYSUMMER', creator: 'Avery'},
      {code: 'JUNO15', creator: 'Juno Park'},
    ]);
    expect(userErrors).toEqual([]);
    expect(creators.map(({handle, name, codes}) => ({handle, name, codes}))).toEqual([
      {handle: 'creator-avery', name: 'Avery', codes: ['AVERY10', 'AVERYSUMMER']},
      {handle: 'creator-juno-park', name: 'Juno Park', codes: ['JUNO15']},
    ]);
    expect(ops(calls)).toEqual(['CreatorByHandle', 'UpsertCreator', 'CreatorByHandle', 'UpsertCreator']);
  });

  it('keeps the codes an earlier campaign gave a creator', async () => {
    const store = creatorStore({'creator-avery': avery});
    const {admin} = mockAdmin(store);
    const {creators} = await upsertCreators(admin, [{code: 'AVERYFALL', creator: 'Avery'}]);
    expect(creators).toEqual([{...avery, codes: ['AVERY10', 'AVERYFALL']}]);
  });

  it('writes the same entry when the same creator is named twice', async () => {
    const store = creatorStore();
    const {admin} = mockAdmin(store);
    const first = await upsertCreators(admin, [{code: 'AVERY10', creator: 'Avery'}]);
    const second = await upsertCreators(admin, [{code: 'AVERY10', creator: 'Avery'}]);
    expect(second.creators).toEqual(first.creators);
    expect(store.entries.size).toBe(1);
  });

  it('round-trips the referenced creators through the entry', () => {
    const campaign = campaignFromNode(node({id: 4210, creators: [avery]}));
    expect(campaign.creators).toEqual([avery]);
    expect(campaignFields({creators: campaign.creators})).toEqual([
      {key: 'creators', value: '["gid://shopify/Metaobject/70"]'},
    ]);
  });

  it('reads an entry stored before the creators field as having none', () => {
    const entry = node({id: 4210});
    entry.fields.push({key: 'creator_codes', jsonValue: [{code: 'OLD', creator: 'Old'}]});
    expect(campaignFromNode(entry).creators).toEqual([]);
  });

  it('sanitizes codes a merchant edits in the admin', () => {
    expect(creatorFromNode(creatorNode({...avery, codes: ["av'ery 10", '']})).codes).toEqual(['AVERY10']);
  });
});

describe('ensureCampaign', () => {
  const definition = objectDefinitions();
  const seeding = () => ({
    ObjectDefinition: definition,
    CampaignList: listOf([]),
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
    UpsertCampaign: ({handle}) => ({
      data: {
        metaobjectUpsert: {
          metaobject: node({gid: `gid-${handle.handle}`, handle: handle.handle, id: Number(handle.handle.split('-')[1])}),
          userErrors: [],
        },
      },
    }),
  });

  it('seeds two campaigns and spends both IDs on a new store', async () => {
    const {admin, calls} = mockAdmin(seeding());
    const result = await ensureCampaign(admin, SHOP);
    expect(result.userErrors).toEqual([]);
    expect(result.campaigns.map((campaign) => campaign.id)).toEqual([4210, 4211]);
    const upserts = calls.filter((call) => call.op === 'UpsertCampaign');
    expect(upserts.map((call) => call.variables.handle.handle).sort()).toEqual(['campaign-4210', 'campaign-4211']);
    expect(tablesOf().shopState).toEqual([{shop: SHOP, lastCampaignId: 4211}]);
  });

  it('seeds the creators on fixed handles and references them from the campaign', async () => {
    const {admin, calls} = mockAdmin(seeding());
    await ensureCampaign(admin, SHOP);
    const creators = calls.filter((call) => call.op === 'UpsertCreator');
    expect(creators.map((call) => [call.variables.handle, call.variables.metaobject.fields])).toEqual([
      [
        {type: 'campaign_dashboard_creator', handle: 'creator-avery'},
        [{key: 'name', value: 'Avery'}, {key: 'discount_codes', value: '["AVERY10","AVERYSUMMER"]'}],
      ],
      [
        {type: 'campaign_dashboard_creator', handle: 'creator-juno'},
        [{key: 'name', value: 'Juno'}, {key: 'discount_codes', value: '["JUNO15"]'}],
      ],
    ]);
    const summer = calls.find((call) => call.op === 'UpsertCampaign' && call.variables.handle.handle === 'campaign-4210');
    expect(summer.variables.metaobject.fields).toContainEqual({key: 'creators', value: '["gid-creator-avery","gid-creator-juno"]'});
    const school = calls.find((call) => call.op === 'UpsertCampaign' && call.variables.handle.handle === 'campaign-4211');
    expect(school.variables.metaobject.fields.map((field) => field.key)).not.toContain('creators');
  });

  it('skips the seed once the shop has spent campaign IDs', async () => {
    await db.shopState.create({data: {shop: SHOP, lastCampaignId: 4211}});
    const {admin, calls} = mockAdmin({
      ObjectDefinition: definition,
      CampaignList: listOf([]),
    });
    const result = await ensureCampaign(admin, SHOP);
    expect(result.campaigns).toEqual([]);
    expect(ops(calls)).toEqual(['ObjectDefinition', 'ObjectDefinition', 'CampaignList']);
  });

  it('refuses to seed on a failed read', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: definition,
      CampaignList: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect((await ensureCampaign(admin, SHOP)).userErrors).toEqual([{message: 'Throttled'}]);
    expect(ops(calls)).not.toContain('UpsertCampaign');
    expect(ops(calls)).not.toContain('UpsertCreator');
  });
});

describe('createCampaign', () => {
  const creating = (extra) => ({
    CreateCampaign: ({metaobject}) => ({
      data: {metaobjectCreate: {metaobject: node({gid: `gid-${metaobject.handle}`, handle: metaobject.handle, id: 0}), userErrors: []}},
    }),
    ...extra,
  });

  it('spends the next ID past a deleted campaign and creates the entry under its handle', async () => {
    await db.shopState.create({data: {shop: SHOP, lastCampaignId: 4212}});
    const {admin, calls} = mockAdmin(creating({CampaignList: listOf([node({id: 4210})])}));
    const {campaign, userErrors} = await createCampaign(admin, SHOP, {title: 'Fall'});
    expect(userErrors).toEqual([]);
    expect(campaign).toMatchObject({handle: 'campaign-4213', shop: SHOP, markers: {}, targets: {}, sentEvents: null});
    expect(ops(calls)).toEqual(['CampaignList', 'CampaignQRCodes', 'CreateCampaign']);
    const fields = Object.fromEntries(calls[2].variables.metaobject.fields.map((field) => [field.key, field.value]));
    expect(fields).toMatchObject({campaign_id: '4213', status: 'planned', audience: 'everyone', title: 'Fall'});
    expect(tablesOf().shopState).toEqual([{shop: SHOP, lastCampaignId: 4213}]);
  });

  it('counts past an entry made before the shop had spent IDs', async () => {
    const {admin} = mockAdmin(creating({CampaignList: listOf([node({id: 4215})])}));
    expect((await createCampaign(admin, SHOP, {})).campaign.handle).toBe('campaign-4216');
  });

  it('deletes a suffixed entry and retries with the next ID', async () => {
    await db.shopState.create({data: {shop: SHOP, lastCampaignId: 4211}});
    const {admin, calls} = mockAdmin({
      CampaignList: listOf([]),
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
    const {campaign} = await createCampaign(admin, SHOP, {title: 'Race'});
    expect(campaign.handle).toBe('campaign-4213');
    expect(calls.find((call) => call.op === 'DeleteCampaign').variables.id).toBe('gid-campaign-4212');
    expect(tablesOf().shopState[0].lastCampaignId).toBe(4213);
  });

  it('hands out no ID on a failed read', async () => {
    const {admin, calls} = mockAdmin({
      CampaignList: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect((await createCampaign(admin, SHOP, {})).userErrors).toEqual([{message: 'Throttled'}]);
    expect(ops(calls)).toEqual(['CampaignList']);
    expect(tablesOf().shopState).toEqual([]);
  });

  it('stops when the ID fails to save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db.shopState, 'update').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const {admin, calls} = mockAdmin(creating({CampaignList: listOf([])}));
    expect((await createCampaign(admin, SHOP, {})).userErrors).toEqual([{message: "Couldn't assign a campaign ID. Try again."}]);
    expect(ops(calls)).not.toContain('CreateCampaign');
  });
});

describe('entry writes', () => {
  const updated = () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: []}}});

  it("saves markers and targets in the app's database and writes the rest to the entry", async () => {
    const campaign = withState(campaignFromNode(node({id: 4210})), SHOP, null);
    const {admin, calls} = mockAdmin({UpdateCampaign: updated});
    await updateCampaign(admin, campaign, {status: 'running', targets: {store: 't1'}});
    expect(calls.map((call) => call.variables.metaobject.fields)).toEqual([[{key: 'status', value: 'running'}]]);
    expect(storedState(4210)).toMatchObject({campaignGid: 'gid://shopify/Metaobject/1', targets: {store: 't1'}, markers: {}});
  });

  it('skips the entry write when the change holds only records', async () => {
    const campaign = withState(campaignFromNode(node({id: 4210})), SHOP, null);
    const {admin, calls} = mockAdmin({});
    expect((await updateCampaign(admin, campaign, {markers: {campaign: 'a1'}})).userErrors).toEqual([]);
    expect(calls).toEqual([]);
    expect(storedState(4210).markers).toEqual({campaign: 'a1'});
  });

  it('writes no entry field when the records fail to save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db.campaignState, 'update').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const campaign = withState(campaignFromNode(node({id: 4210})), SHOP, null);
    const {admin, calls} = mockAdmin({UpdateCampaign: updated});
    const {userErrors} = await updateCampaign(admin, campaign, {status: 'running', targets: {store: 't1'}});
    expect(userErrors).toEqual([{message: "Couldn't save the campaign's records. Try again."}]);
    expect(calls).toEqual([]);
  });

  it('merges new marker IDs into the stored ones', async () => {
    const stale = withState(campaignFromNode(node({id: 4210})), SHOP, null);
    seedState({campaignId: 4210, markers: {campaign: 'a1'}});
    expect(await rememberMarkers(stale, {launch: 'a2'})).toEqual({userErrors: []});
    expect(storedState(4210).markers).toEqual({campaign: 'a1', launch: 'a2'});
  });

  it('deletes a redacted customer\'s tier metafield and writes no campaign', async () => {
    const {admin, calls} = mockAdmin({
      DeleteCustomerTier: () => ({data: {metafieldsDelete: {deletedMetafields: [{key: 'tier'}], userErrors: []}}}),
    });
    expect(await forgetCustomer(admin, 'gid://shopify/Customer/5')).toEqual([]);
    expect(calls[0].variables.metafields).toEqual([
      {ownerId: 'gid://shopify/Customer/5', namespace: '$app:campaign_dashboard', key: 'tier'},
    ]);
    expect(ops(calls)).toEqual(['DeleteCustomerTier']);
  });

  it("reads each code's live date from the code", async () => {
    const {admin} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210})]),
      CampaignQRCodes: qrCodeList([qrCodeNode({id: 'gid://shopify/Metaobject/901', handle: 'a', liveOn: '2026-09-20', campaign: 'g1'})]),
    });
    const {campaigns} = await readCampaigns(admin, SHOP);
    expect(campaigns[0].qrCodes).toEqual([{id: 'gid://shopify/Metaobject/901', handle: 'a', title: '', liveOn: '2026-09-20'}]);
  });
});

describe('returned errors', () => {
  const answering = (status) => mockAdmin({Probe: () => new Response('{}', {status})});
  const probe = (admin) => admin.graphql('query Probe { shop { id } }');

  it.each([429, 503])('returns HTTP %s as errors in the body', async (status) => {
    const body = await (await probe(answering(status).admin)).json();
    expect(body).toEqual({data: null, errors: [{message: `Shopify returned HTTP ${status}. Try again.`}]});
  });

  it.each([302, 401])('lets HTTP %s through to reauthorize', async (status) => {
    const thrown = await probe(answering(status).admin).catch((error) => error);
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(status);
  });
});

describe('campaign lock', () => {
  it('refuses while another request holds the campaign, then takes it after the release', async () => {
    const first = await lockCampaign(SHOP, 4210);
    expect(await lockCampaign(SHOP, '4210')).toEqual({
      problems: [{message: 'Another change to this campaign is in progress. Reload in a moment.'}],
    });
    await first.release();
    expect((await lockCampaign(SHOP, 4210)).release).toBeTypeOf('function');
  });

  it('holds each shop and campaign apart', async () => {
    await lockCampaign(SHOP, 4210);
    expect((await lockCampaign(SHOP, 4211)).problems).toBeUndefined();
    expect((await lockCampaign('other.test', 4210)).problems).toBeUndefined();
  });

  it('takes over a lock older than five minutes', async () => {
    await lockCampaign(SHOP, 4210);
    vi.setSystemTime(new Date('2026-09-30T12:05:01Z'));
    expect((await lockCampaign(SHOP, 4210)).problems).toBeUndefined();
  });

  it('leaves a lock alone once another request takes it over', async () => {
    const lock = await lockCampaign(SHOP, 4210);
    vi.setSystemTime(new Date('2026-09-30T12:06:00Z'));
    await lockCampaign(SHOP, 4210);
    const [taker] = tablesOf().campaignLock;
    await lock.release();
    expect(tablesOf().campaignLock).toEqual([taker]);
  });

  it('names a failed lock write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db.campaignLock, 'create').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    expect(await lockCampaign(SHOP, 4210)).toEqual({problems: [{message: "Couldn't lock the campaign. Try again."}]});
  });

  it('logs a failed release and returns', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lock = await lockCampaign(SHOP, 4210);
    vi.spyOn(db.campaignLock, 'deleteMany').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await expect(lock.release()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });
});

describe('QR code moves under the lock', () => {
  const held = () => tablesOf().campaignLock.map((lock) => lock.campaignId);
  const moving = (before, after, codeAfter = 'g1') =>
    mockAdmin({
      CampaignList: (variables, seen) =>
        listOf(seen.filter((call) => call.op === 'CampaignList').length > 1 ? after : before)(variables),
      CampaignQRCodes: (variables, seen) =>
        qrCodeList([
          qrCodeNode({
            id: 'gid://shopify/Metaobject/901',
            handle: 'a',
            campaign: seen.filter((call) => call.op === 'CampaignQRCodes').length > 1 ? codeAfter : 'g1',
          }),
        ])(variables),
    });

  it('refuses a campaign activated after the form loaded', async () => {
    const {admin, calls} = moving(
      [node({gid: 'g1', id: 4210, title: 'Fall'})],
      [node({gid: 'g1', id: 4210, title: 'Fall', status: 'running'})],
    );
    expect(await lockQRCodeMove(admin, SHOP, 'gid://shopify/Metaobject/902', 'g1')).toEqual({
      problems: [{code: 'NOT_PLANNED', message: 'Fall is active. QR codes move only between planned campaigns.'}],
    });
    expect(ops(calls)).not.toContain('UpdateCampaign');
    expect(held()).toEqual([]);
  });

  it("refuses when the code's old campaign left planning", async () => {
    const {admin} = moving(
      [node({gid: 'g1', id: 4210, title: 'Fall'}), node({gid: 'g2', id: 4211, title: 'Winter'})],
      [node({gid: 'g1', id: 4210, title: 'Fall', status: 'running'}), node({gid: 'g2', id: 4211, title: 'Winter'})],
    );
    expect((await lockQRCodeMove(admin, SHOP, 'gid://shopify/Metaobject/901', 'g2')).problems).toEqual([
      {code: 'NOT_PLANNED', message: 'Fall is active. QR codes move only between planned campaigns.'},
    ]);
    expect(held()).toEqual([]);
  });

  it('refuses when another request moved the code to an unlocked campaign', async () => {
    const entries = [node({gid: 'g1', id: 4210}), node({gid: 'g2', id: 4211}), node({gid: 'g3', id: 4212})];
    const {admin} = moving(entries, entries, 'g3');
    expect((await lockQRCodeMove(admin, SHOP, 'gid://shopify/Metaobject/901', 'g2')).problems).toEqual([
      {code: 'STALE', message: 'This QR code changed while you were working. Reload the page and try again.'},
    ]);
    expect(held()).toEqual([]);
  });

  it('holds the old and new campaigns until the release', async () => {
    const entries = [node({gid: 'g1', id: 4210}), node({gid: 'g2', id: 4211}), node({gid: 'g3', id: 4212})];
    const {admin} = moving(entries, entries);
    const lock = await lockQRCodeMove(admin, SHOP, 'gid://shopify/Metaobject/901', 'g2');
    expect(lock.problems).toBeUndefined();
    expect(held()).toEqual([4210, 4211]);
    await lock.release();
    expect(held()).toEqual([]);
  });

  it('releases the locks it took when one campaign is held', async () => {
    await lockCampaign(SHOP, 4211);
    const entries = [node({gid: 'g1', id: 4210}), node({gid: 'g2', id: 4211})];
    const {admin} = moving(entries, entries);
    expect((await lockQRCodeMove(admin, SHOP, 'gid://shopify/Metaobject/901', 'g2')).problems).toEqual([
      {message: 'Another change to this campaign is in progress. Reload in a moment.'},
    ]);
    expect(held()).toEqual([4211]);
  });
});

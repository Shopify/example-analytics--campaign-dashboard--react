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
  nextCampaignId,
  readCampaigns,
  rememberMarkers,
  updateCampaign,
  upsertCreators,
  withReturnedErrors,
} from '../app/campaigns.server';
import {lockStore, mockAdmin, ops} from './helpers/admin';
import {ALL_FIELDS, creatorNode, listOf, node, objectDefinitions, qrCodeList, qrCodeNode} from './helpers/campaign';

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
        audience: 'vip',
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
      qrCodes: [],
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
    const {campaigns, failed} = await readCampaigns(admin);
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
    const {campaigns} = await readCampaigns(admin);
    expect(campaigns[0].qrCodes.map((qrCode) => qrCode.id)).toEqual(['q1', 'q2']);
    expect(calls.filter((call) => call.op === 'CampaignQRCodes').map((call) => call.variables)).toEqual([{after: null}, {after: 'c1'}]);
  });

  it('fails the read past 20 pages of QR codes', async () => {
    const {admin} = mockAdmin({
      CampaignList: listOf([node({gid: 'g1', id: 4210})]),
      CampaignQRCodes: () => ({data: {metaobjects: {nodes: [], pageInfo: {hasNextPage: true, endCursor: 'more'}}}}),
    });
    expect(await readCampaigns(admin)).toMatchObject({
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
    expect((await readCampaigns(admin)).failed).toEqual([
      {message: 'This store has more than 5,000 campaigns. The campaign dashboard reads up to 5,000.'},
    ]);
    expect(ops(calls).filter((op) => op === 'CampaignList')).toHaveLength(20);
  });

  it('fails the read when the QR code list fails', async () => {
    const {admin} = mockAdmin({
      CampaignList: listOf([node({id: 4210})]),
      CampaignQRCodes: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect(await readCampaigns(admin)).toMatchObject({failed: [{message: 'Throttled'}], campaigns: []});
  });

  it('skips the QR code list without campaigns', async () => {
    const {admin, calls} = mockAdmin({CampaignList: listOf([])});
    await readCampaigns(admin);
    expect(ops(calls)).toEqual(['CampaignList']);
  });

  it('writes only the keys in the change, and an empty value clears', () => {
    expect(campaignFields({revenueTarget: '', products: [{id: 'gid://shopify/Product/1'}], markers: {a: 'b'}})).toEqual([
      {key: 'products', value: '["gid://shopify/Product/1"]'},
      {key: 'revenue_target', value: ''},
      {key: 'markers', value: '{"a":"b"}'},
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
    SetCampaignMetafields: () => ({data: {metafieldsSet: {metafields: [], userErrors: []}}}),
  });

  it('seeds two campaigns and spends both IDs on a new store', async () => {
    const {admin, calls} = mockAdmin(seeding());
    const result = await ensureCampaign(admin);
    expect(result.userErrors).toEqual([]);
    expect(result.campaigns.map((campaign) => campaign.id)).toEqual([4210, 4211]);
    const upserts = calls.filter((call) => call.op === 'UpsertCampaign');
    expect(upserts.map((call) => call.variables.handle.handle).sort()).toEqual(['campaign-4210', 'campaign-4211']);
    expect(calls.at(-1).variables.metafields[0]).toMatchObject({key: 'last_campaign_id', value: '4211'});
  });

  it('seeds the creators on fixed handles and references them from the campaign', async () => {
    const {admin, calls} = mockAdmin(seeding());
    await ensureCampaign(admin);
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

  it('skips the seed once a high-water mark exists', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: definition,
      CampaignList: listOf([], {value: '4211'}),
    });
    const result = await ensureCampaign(admin);
    expect(result.campaigns).toEqual([]);
    expect(ops(calls)).toEqual(['ObjectDefinition', 'ObjectDefinition', 'CampaignList']);
  });

  it('refuses to seed on a failed read', async () => {
    const {admin, calls} = mockAdmin({
      ObjectDefinition: definition,
      CampaignList: () => ({errors: [{message: 'Throttled'}], data: null}),
    });
    expect((await ensureCampaign(admin)).userErrors).toEqual([{message: 'Throttled'}]);
    expect(ops(calls)).not.toContain('UpsertCampaign');
    expect(ops(calls)).not.toContain('UpsertCreator');
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
    expect(ops(calls)).toEqual(['CampaignList', 'CampaignQRCodes', 'SetCampaignMetafields', 'CreateCampaign']);
    const fields = Object.fromEntries(calls[3].variables.metaobject.fields.map((field) => [field.key, field.value]));
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

  it('refuses to record markers after another request changed the campaign', async () => {
    const campaign = {...campaignFromNode(node({id: 4210})), updatedAt: '2026-09-30T10:00:00Z'};
    const {admin, calls} = mockAdmin({
      CampaignById: () => ({data: {metaobject: node({id: 4210, updatedAt: '2026-09-30T10:05:00Z'})}}),
      CampaignVersion: () => ({data: {metaobject: {updatedAt: '2026-09-30T10:05:00Z'}}}),
      UpdateCampaign: updated,
    });
    const {userErrors} = await rememberMarkers(admin, campaign, {launch: 'a2'});
    expect(userErrors[0].code).toBe('STALE');
    expect(ops(calls)).not.toContain('UpdateCampaign');
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
    const {campaigns} = await readCampaigns(admin);
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
  it("leaves a lock alone once another request takes it over", async () => {
    const locks = lockStore();
    const {admin, calls} = mockAdmin(locks);
    const lock = await lockCampaign(admin, 4210);
    locks.held.set('lock_4210', '2026-09-30T12:06:00.000Z|other');
    await lock.release();
    expect(locks.held.get('lock_4210')).toBe('2026-09-30T12:06:00.000Z|other');
    expect(ops(calls)).not.toContain('ReleaseCampaignLock');
  });

  it('names a refusal other than a lost race', async () => {
    const {admin} = mockAdmin({
      ...lockStore(),
      TakeCampaignLock: () => ({data: {metafieldsSet: {userErrors: [{code: 'INVALID', message: 'Value is too long.'}]}}}),
    });
    expect(await lockCampaign(admin, 4210)).toEqual({problems: [{message: 'Value is too long.'}]});
  });

  it('logs a failed release and returns', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const {admin} = mockAdmin({...lockStore(), ReleaseCampaignLock: () => new Response(null, {status: 401})});
    const lock = await lockCampaign(admin, 4210);
    await expect(lock.release()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });
});

describe('QR code moves under the lock', () => {
  const moving = (before, after, codeAfter = 'g1') => {
    const locks = lockStore();
    const mock = mockAdmin({
      ...locks,
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
    return {...mock, locks};
  };

  it('refuses a campaign activated after the form loaded', async () => {
    const {admin, calls, locks} = moving(
      [node({gid: 'g1', id: 4210, title: 'Fall'})],
      [node({gid: 'g1', id: 4210, title: 'Fall', status: 'running'})],
    );
    expect(await lockQRCodeMove(admin, 'gid://shopify/Metaobject/902', 'g1')).toEqual({
      problems: [{code: 'NOT_PLANNED', message: 'Fall is active. QR codes move only between planned campaigns.'}],
    });
    expect(ops(calls)).not.toContain('UpdateCampaign');
    expect(locks.held.size).toBe(0);
  });

  it("refuses when the code's old campaign left planning", async () => {
    const {admin, locks} = moving(
      [node({gid: 'g1', id: 4210, title: 'Fall'}), node({gid: 'g2', id: 4211, title: 'Winter'})],
      [node({gid: 'g1', id: 4210, title: 'Fall', status: 'running'}), node({gid: 'g2', id: 4211, title: 'Winter'})],
    );
    expect((await lockQRCodeMove(admin, 'gid://shopify/Metaobject/901', 'g2')).problems).toEqual([
      {code: 'NOT_PLANNED', message: 'Fall is active. QR codes move only between planned campaigns.'},
    ]);
    expect(locks.held.size).toBe(0);
  });

  it('refuses when another request moved the code to an unlocked campaign', async () => {
    const entries = [node({gid: 'g1', id: 4210}), node({gid: 'g2', id: 4211}), node({gid: 'g3', id: 4212})];
    const {admin, locks} = moving(entries, entries, 'g3');
    expect((await lockQRCodeMove(admin, 'gid://shopify/Metaobject/901', 'g2')).problems).toEqual([
      {code: 'STALE', message: 'This QR code changed while you were working. Reload the page and try again.'},
    ]);
    expect(locks.held.size).toBe(0);
  });

  it('holds the old and new campaigns until the release', async () => {
    const entries = [node({gid: 'g1', id: 4210}), node({gid: 'g2', id: 4211}), node({gid: 'g3', id: 4212})];
    const {admin, locks} = moving(entries, entries);
    const lock = await lockQRCodeMove(admin, 'gid://shopify/Metaobject/901', 'g2');
    expect(lock.problems).toBeUndefined();
    expect([...locks.held.keys()]).toEqual(['lock_4210', 'lock_4211']);
    await lock.release();
    expect(locks.held.size).toBe(0);
  });
});

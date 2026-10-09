import {AUDIENCE_TIERS, TIER_METAFIELD} from './audiences';
import {
  CAMPAIGN_CREATE,
  CAMPAIGN_DELETE,
  CAMPAIGN_TYPE,
  CAMPAIGN_UPDATE,
  CAMPAIGN_UPSERT,
  CAMPAIGNS_QUERY,
  CREATOR_BY_HANDLE,
  CREATOR_TYPE,
  CREATOR_UPSERT,
  CUSTOMER_TIER,
  METAFIELDS_DELETE,
  OBJECT_DEFINITION_CREATE,
  OBJECT_DEFINITION_QUERY,
  OBJECT_FIELDS_ADD,
  QR_CODE_CAMPAIGNS,
} from './campaign-queries.server';
import {
  allocateCampaignId,
  emptyState,
  hasSpentIds,
  mergeMarkers,
  readStates,
  releaseLock,
  saveState,
  spendThrough,
  takeLock,
} from './campaign-state.server';
import {CHANNELS} from './channels';
import {DIMENSION_NAMESPACE, sanitizeCode, statusLabel} from './campaigns';

// [START campaign-dashboard.campaign-ids]
// IDs stay spent. No endpoint deletes an event, and a reused ID inherits its funnel.
export const FIRST_CAMPAIGN_ID = 4210;

// The handle is the entry's lookup key. The integer is what App Events filters on.
export const campaignHandle = (id) => `campaign-${id}`;

// The new ID comes from the app's database, above this floor. The highest stored ID alone
// forgets a deleted campaign. The floor covers entries the database has no record of.
export const campaignIdFloor = (campaigns) =>
  campaigns.reduce(
    (highest, campaign) => Math.max(highest, Number(campaign.id) || 0),
    FIRST_CAMPAIGN_ID - 1,
  );
// [END campaign-dashboard.campaign-ids]

// [START campaign-dashboard.campaign-store]
// Every query, target, and annotation on the dashboard derives from these fields.
// Each campaign is an entry the merchant can open in the admin. Descriptions show there.
// The IDs the app tracks for each campaign live in its database. See campaign-state.server.js.
const choices = (values) => [{name: 'choices', value: JSON.stringify(values)}];
const atLeastZero = [{name: 'min', value: '0'}];

export const CAMPAIGN_FIELDS = [
  {
    field: 'title',
    key: 'title',
    name: 'Title',
    type: 'single_line_text_field',
    required: true,
    description: 'Campaign name. Appears in each annotation title.',
  },
  {
    field: 'id',
    key: 'campaign_id',
    name: 'Campaign ID',
    type: 'number_integer',
    required: true,
    validations: [{name: 'min', value: String(FIRST_CAMPAIGN_ID)}],
    description: 'Numeric ID that links App Events to this campaign.',
  },
  {
    field: 'startDate',
    key: 'start_date',
    name: 'Start date',
    type: 'date',
    required: true,
    description: 'First day of the campaign.',
  },
  {
    field: 'endDate',
    key: 'end_date',
    name: 'End date',
    type: 'date',
    required: true,
    description: 'Last day of the campaign.',
  },
  {
    field: 'channels',
    key: 'channels',
    name: 'Channels',
    type: 'list.single_line_text_field',
    validations: choices(Object.keys(CHANNELS)),
    description: 'Channels the campaign sends on.',
  },
  {
    field: 'products',
    key: 'products',
    name: 'Promoted products',
    type: 'list.product_reference',
    validations: [{name: 'list.max', value: '5'}],
    description: 'Each one gets a reference back to this campaign at activation.',
  },
  {
    field: 'audience',
    key: 'audience',
    name: 'Customer segment',
    type: 'single_line_text_field',
    validations: choices(AUDIENCE_TIERS.map((tier) => tier.value)),
    description: 'Tier value written onto each targeted customer at activation.',
  },
  // ensureDefinition adds a second validation. It names the Creator definition's ID.
  {
    field: 'creators',
    key: 'creators',
    name: 'Creators',
    type: 'list.metaobject_reference',
    validations: [{name: 'list.max', value: '50'}],
    description: 'Creators who share a discount code for this campaign.',
  },
  {
    field: 'revenueTarget',
    key: 'revenue_target',
    name: 'Revenue target',
    type: 'number_decimal',
    validations: atLeastZero,
    description: 'Store-wide sales target. Empty means no target.',
  },
  {
    field: 'productTarget',
    key: 'product_target',
    name: 'Product target',
    type: 'number_decimal',
    validations: atLeastZero,
    description: 'Sales target filtered to the promoted products.',
  },
  {
    field: 'audienceTarget',
    key: 'audience_target',
    name: 'Customer segment target',
    type: 'number_decimal',
    validations: atLeastZero,
    description: 'Sales target filtered to the targeted tier.',
  },
  {
    field: 'qrTarget',
    key: 'qr_target',
    name: 'QR code target',
    type: 'number_decimal',
    validations: atLeastZero,
    description: 'Sales target for each assigned QR code.',
  },
  {
    field: 'status',
    key: 'status',
    name: 'Status',
    type: 'single_line_text_field',
    required: true,
    validations: choices(['planned', 'running', 'closed', 'canceled']),
    description: 'Planned, running, closed, or canceled.',
  },
];
// [END campaign-dashboard.campaign-store]

// [START campaign-dashboard.creator-store]
// One entry per creator. Every campaign that names the creator references it.
export const CREATOR_FIELDS = [
  {
    field: 'name',
    key: 'name',
    name: 'Name',
    type: 'single_line_text_field',
    required: true,
    description: 'The name the creator posts under.',
  },
  {
    field: 'codes',
    key: 'discount_codes',
    name: 'Discount codes',
    type: 'list.single_line_text_field',
    description: 'Discount codes the creator shares.',
  },
];
// [END campaign-dashboard.creator-store]

// [START campaign-dashboard.campaign-definition]
const fieldInput = ({field, ...definition}, creatorDefinitionId) =>
  definition.type === 'list.metaobject_reference'
    ? {
        ...definition,
        validations: [
          ...(definition.validations ?? []),
          {name: 'metaobject_definition_id', value: creatorDefinitionId},
        ],
      }
    : definition;

const missingFields = (stored, fields) => {
  const keys = new Set(stored.fieldDefinitions.map((field) => field.key));
  return fields.filter((definition) => !keys.has(definition.key));
};

// A field added after the first install reaches existing stores on the next load.
async function addMissingFields(admin, stored, fields, read) {
  const missing = missingFields(stored, fields);
  if (!missing.length) return {definitionId: stored.id, userErrors: []};

  const body = await (
    await admin.graphql(OBJECT_FIELDS_ADD, {
      variables: {
        id: stored.id,
        definition: {
          fieldDefinitions: missing.map((definition) => ({create: definition})),
        },
      },
    })
  ).json();
  const userErrors = [
    ...transportErrors(body),
    ...(body.data?.metaobjectDefinitionUpdate?.userErrors ?? []),
  ];
  if (!userErrors.length) return {definitionId: stored.id, userErrors};
  // Two loads race to add the same field. The loser finds it already there.
  const again = (await read()).data?.definition;
  if (again && !missingFields(again, fields).length) return {definitionId: stored.id, userErrors: []};
  return {definitionId: null, userErrors};
}

async function ensureType(admin, {fieldDefinitions, ...definition}) {
  const read = async () =>
    (
      await admin.graphql(OBJECT_DEFINITION_QUERY, {
        variables: {type: definition.type},
      })
    ).json();

  const body = await read();
  const failed = transportErrors(body);
  if (failed.length) return {definitionId: null, userErrors: failed};

  const stored = body.data?.definition;
  if (stored) return addMissingFields(admin, stored, fieldDefinitions, read);

  const created = await (
    await admin.graphql(OBJECT_DEFINITION_CREATE, {
      variables: {definition: {...definition, fieldDefinitions}},
    })
  ).json();

  const result = created.data?.metaobjectDefinitionCreate;
  if (result?.metaobjectDefinition) {
    return {definitionId: result.metaobjectDefinition.id, userErrors: []};
  }
  // Two first loads race to create it. The loser finds the winner's definition.
  const again = await read();
  if (again.data?.definition) return {definitionId: again.data.definition.id, userErrors: []};
  return {
    definitionId: null,
    userErrors: [...transportErrors(created), ...(result?.userErrors ?? [])],
  };
}

// The Creator type comes first. The Campaign's `creators` field validates against its ID.
export async function ensureDefinition(admin) {
  const creator = await ensureType(admin, {
    type: CREATOR_TYPE,
    name: 'Creator',
    description: 'Creators who share discount codes for campaigns in the campaign dashboard app.',
    displayNameKey: 'name',
    fieldDefinitions: CREATOR_FIELDS.map((definition) => fieldInput(definition)),
  });
  if (!creator.definitionId) return creator;

  return ensureType(admin, {
    type: CAMPAIGN_TYPE,
    name: 'Campaign',
    description: 'Marketing campaigns planned in the campaign dashboard app.',
    displayNameKey: 'title',
    fieldDefinitions: CAMPAIGN_FIELDS.map((definition) =>
      fieldInput(definition, creator.definitionId),
    ),
  });
}
// [END campaign-dashboard.campaign-definition]

// [START campaign-dashboard.campaign-read]
// `admin.graphql` throws on top-level `errors` and on any HTTP error status. A throw halfway
// through a write skips the cleanup after it. This client returns those errors in the body.
export function withReturnedErrors(admin) {
  return {
    ...admin,
    graphql: async (query, options) => {
      try {
        return await admin.graphql(query, options);
      } catch (error) {
        if (error instanceof Response) {
          // A redirect or a 401 sends the merchant to reauthorize. Let both through.
          if ((error.status >= 300 && error.status < 400) || error.status === 401) throw error;
          const message = `Shopify returned HTTP ${error.status}. Try again.`;
          // The library drops a 429's body. The code still marks it for a retry.
          const extensions = error.status === 429 ? {code: 'THROTTLED'} : undefined;
          return new Response(JSON.stringify({data: null, errors: [{message, extensions}]}));
        }
        const errors = error.body?.errors?.graphQLErrors ?? [{message: error.message}];
        // `extensions` carries the ShopifyQL budget, including when it refills.
        return new Response(
          JSON.stringify({data: error.body?.data ?? null, errors, extensions: error.body?.extensions}),
        );
      }
    },
  };
}

// A throttled or rejected request answers with `errors` and a null `data`. There are no
// nested `userErrors` to find, and an unchecked call reads as a clean one.
export const transportErrors = (body) =>
  (body.errors ?? []).map((error) => ({message: error.message}));

const isRecord = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

// The merchant can edit any field in the admin. Read defensively and keep the app up.
export function campaignFromNode(node) {
  const values = Object.fromEntries(
    (node.fields ?? []).map((field) => [field.key, field.jsonValue]),
  );
  const titles = new Map(
    (node.products?.references?.nodes ?? [])
      .filter((product) => product?.id)
      .map((product) => [product.id, product.title]),
  );

  return {
    gid: node.id,
    handle: node.handle,
    id: Number(values.campaign_id),
    title: values.title ?? '',
    startDate: values.start_date ?? '',
    endDate: values.end_date ?? '',
    channels: listOf(values.channels),
    // The reference list drops a deleted product. The title map drops it too.
    products: listOf(values.products)
      .filter((id) => titles.has(id))
      .map((id) => ({id, title: titles.get(id) ?? ''})),
    // Each code names its campaign. readCampaigns fills this in from the codes.
    qrCodes: [],
    audience: values.audience ?? 'everyone',
    // An entry from before the `creators` field has no references and no creators.
    creators: (node.creators?.references?.nodes ?? [])
      .filter((creator) => creator?.id)
      .map(creatorFromNode),
    revenueTarget: values.revenue_target ?? '',
    productTarget: values.product_target ?? '',
    audienceTarget: values.audience_target ?? '',
    qrTarget: values.qr_target ?? '',
    status: values.status ?? 'planned',
  };
}

// The entry's fields plus the app's own record of it. The shop keys every later write.
// A row written for a different entry with this campaign ID doesn't apply.
export const withState = (campaign, shop, state) => ({
  ...campaign,
  shop,
  ...(state?.gid === campaign.gid ? state : emptyState()),
  gid: campaign.gid,
});

// Entries are editable in the admin. Codes reach ShopifyQL filters.
export function creatorFromNode(node) {
  const values = Object.fromEntries(
    (node.fields ?? []).map((field) => [field.key, field.jsonValue]),
  );
  return {
    id: node.id,
    handle: node.handle,
    name: String(values.name ?? ''),
    codes: listOf(values.discount_codes).map(sanitizeCode).filter(Boolean),
  };
}

// A code whose `campaign` names no stored campaign belongs to none.
async function withQRCodes(admin, campaigns) {
  const byGid = new Map(campaigns.map((campaign) => [campaign.gid, campaign]));
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const body = await (
      await admin.graphql(QR_CODE_CAMPAIGNS, {variables: {after}})
    ).json();
    const failed = transportErrors(body);
    if (failed.length) return failed;
    const connection = body.data?.metaobjects;
    for (const node of connection?.nodes ?? []) {
      const campaign = node?.handle && byGid.get(node.campaign?.value);
      if (!campaign) continue;
      campaign.qrCodes.push({
        id: node.id,
        handle: node.handle,
        title: node.title?.value ?? '',
        liveOn: node.liveOn?.value ?? '',
      });
    }
    if (!connection?.pageInfo?.hasNextPage) return [];
    after = connection.pageInfo.endCursor;
  }
  return [{message: 'This store has more than 5,000 QR codes. The campaign dashboard reads up to 5,000.'}];
}

// Returns this app's ID alongside the records. The namespace derives from it.
export async function readCampaigns(admin, shop) {
  const campaigns = [];
  let installation = null;
  let failed = [];
  let after = null;

  for (let page = 0; page < 20; page += 1) {
    const body = await (
      await admin.graphql(CAMPAIGNS_QUERY, {variables: {type: CAMPAIGN_TYPE, after}})
    ).json();
    failed = transportErrors(body);
    if (failed.length) break;
    installation ??= body.data?.currentAppInstallation ?? null;
    const connection = body.data?.metaobjects;
    campaigns.push(...(connection?.nodes ?? []).map(campaignFromNode));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (page === 19) failed = [{message: 'This store has more than 5,000 campaigns. The campaign dashboard reads up to 5,000.'}];
  }

  if (!failed.length && campaigns.length) failed = await withQRCodes(admin, campaigns);

  let states = new Map();
  if (!failed.length && campaigns.length) {
    try {
      states = await readStates(shop, campaigns.map((campaign) => campaign.id));
    } catch (error) {
      console.error('Could not read campaign state', error);
      failed = [{message: "Couldn't read the app's campaign records. Try again."}];
    }
  }

  return {
    // An empty list from a failed read is indistinguishable from a store with no
    // campaigns. Seeding and ID allocation refuse on a failed read.
    failed,
    appId: installation?.app?.id ?? null,
    // The value `app_name` holds in App Events. Every app writes it.
    appName: installation?.app?.title ?? null,
    campaigns: failed.length
      ? []
      : campaigns
          .map((campaign) => withState(campaign, shop, states.get(campaign.id)))
          .sort((first, second) => first.id - second.id),
  };
}

export const findCampaign = (campaigns, campaignId) =>
  campaigns.find((campaign) => String(campaign.id) === String(campaignId)) ??
  null;
// [END campaign-dashboard.campaign-read]

// [START campaign-dashboard.campaign-write]
// Every field type takes a string. Lists and json take JSON, and an empty string clears.
function fieldValue(definition, value) {
  if (value === null || value === undefined || value === '') return '';
  if (definition.type === 'json') return JSON.stringify(value);
  // Products and creators travel as records. The field stores their IDs.
  if (definition.type.startsWith('list.')) {
    return JSON.stringify(value.map((item) => (isRecord(item) ? item.id : item)));
  }
  return String(value);
}

// Only the keys in `change`. The entry keeps every field the write leaves out.
export const campaignFields = (change) =>
  CAMPAIGN_FIELDS.filter((definition) => definition.field in change).map(
    (definition) => ({
      key: definition.key,
      value: fieldValue(definition, change[definition.field]),
    }),
  );

const entryResult = (body, name) => {
  const failed = transportErrors(body);
  if (failed.length) return {campaign: null, userErrors: failed};
  const result = body.data?.[name];
  return {
    campaign: result?.metaobject ? campaignFromNode(result.metaobject) : null,
    userErrors: result?.userErrors ?? [],
  };
};

const STATE_ERROR = {message: "Couldn't save the campaign's records. Try again."};

// `markers` and `targets` go to the app's database, before the entry. Each holds IDs of
// what's already on the store, and a failed entry write still leaves them accurate.
export async function updateCampaign(admin, campaign, change) {
  const {markers, targets, ...fields} = change;
  if (markers || targets) {
    try {
      await saveState(campaign.shop, campaign.id, campaign.gid, {markers, targets});
    } catch (error) {
      console.error('Could not save campaign state', error);
      return {campaign: null, userErrors: [STATE_ERROR]};
    }
  }
  if (!Object.keys(fields).length) return {campaign, userErrors: []};
  const body = await (
    await admin.graphql(CAMPAIGN_UPDATE, {
      variables: {id: campaign.gid, metaobject: {fields: campaignFields(fields)}},
    })
  ).json();
  return entryResult(body, 'metaobjectUpdate');
}

// Annotation IDs per mark, to find and rewrite an annotation after the campaign runs.
// The merge reads the stored IDs. Each ID lands as its mark saves.
export async function rememberMarkers(campaign, markers) {
  try {
    await mergeMarkers(campaign.shop, campaign.id, campaign.gid, markers);
    return {userErrors: []};
  } catch (error) {
    console.error('Could not save campaign state', error);
    return {userErrors: [STATE_ERROR]};
  }
}
// [END campaign-dashboard.campaign-write]

// [START campaign-dashboard.creator-write]
const slug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Upsert on a handle from the name. A creator named again keeps the codes an earlier
// campaign gave them.
export async function upsertCreators(admin, pairs) {
  const byName = new Map();
  for (const {code, creator} of pairs) {
    byName.set(creator, [...(byName.get(creator) ?? []), code]);
  }
  const creators = [];
  for (const [name, codes] of byName) {
    const handle = {type: CREATOR_TYPE, handle: `creator-${slug(name) || slug(codes[0])}`};
    const read = await (
      await admin.graphql(CREATOR_BY_HANDLE, {variables: {handle}})
    ).json();
    const failed = transportErrors(read);
    if (failed.length) return {creators: [], userErrors: failed};
    const kept = read.data?.metaobjectByHandle
      ? creatorFromNode(read.data.metaobjectByHandle).codes
      : [];

    const body = await (
      await admin.graphql(CREATOR_UPSERT, {
        variables: {
          handle,
          metaobject: {
            fields: [
              {key: 'name', value: name},
              {key: 'discount_codes', value: JSON.stringify([...new Set([...kept, ...codes])])},
            ],
          },
        },
      })
    ).json();
    const result = body.data?.metaobjectUpsert;
    const userErrors = [...transportErrors(body), ...(result?.userErrors ?? [])];
    if (userErrors.length || !result?.metaobject) return {creators: [], userErrors};
    creators.push(creatorFromNode(result.metaobject));
  }
  return {creators, userErrors: []};
}
// [END campaign-dashboard.creator-write]

// Only canceled campaigns reach here, and cancel removed their annotations and targets.
// Shopify drops product references to the entry asynchronously. Creators stay for other campaigns.
export async function deleteCampaign(admin, campaign) {
  const body = await (
    await admin.graphql(CAMPAIGN_DELETE, {variables: {id: campaign.gid}})
  ).json();
  const failed = transportErrors(body);
  if (failed.length) return {userErrors: failed};
  return {userErrors: body.data?.metaobjectDelete?.userErrors ?? []};
}

// [START campaign-dashboard.customer-data]
// The tier metafield is the only customer data this app writes. A data request reads it,
// and a redaction deletes it.
export async function customerTier(admin, customerId) {
  const body = await (
    await admin.graphql(CUSTOMER_TIER, {variables: {id: customerId}})
  ).json();
  return {
    tier: body.data?.customer?.tier?.value ?? null,
    userErrors: transportErrors(body),
  };
}

export async function forgetCustomer(admin, customerId) {
  const body = await (
    await admin.graphql(METAFIELDS_DELETE, {
      variables: {
        metafields: [{ownerId: customerId, namespace: DIMENSION_NAMESPACE, key: TIER_METAFIELD.key}],
      },
    })
  ).json();
  return [...transportErrors(body), ...(body.data?.metafieldsDelete?.userErrors ?? [])];
}
// [END campaign-dashboard.customer-data]

// [START campaign-dashboard.qr-assign]
// A failed activation leaves the campaign planned with its targets saved. Its codes wait
// for a cancel, which deletes the targets.
export const heldByTargets = (campaign) =>
  Object.keys(campaign.targets ?? {}).length > 0
    ? `${campaign.title} already has targets from an activation. Cancel the campaign, then change its QR codes.`
    : null;

// A code moves only between planned campaigns. The locks keep both campaigns planned
// until the caller saves the code's `campaign` field and releases them.
export async function lockQRCodeMove(admin, shop, qrCodeId, campaignGid) {
  const before = await readCampaigns(admin, shop);
  if (before.failed.length) return {problems: before.failed};
  const touched = before.campaigns.filter(
    (campaign) =>
      campaign.gid === campaignGid ||
      campaign.qrCodes.some((qrCode) => qrCode.id === qrCodeId),
  );
  const lock = await lockCampaigns(shop, touched.map((campaign) => campaign.id));
  if (lock.problems) return lock;

  // The form loaded before the lock. A campaign activated since then keeps its codes.
  const {campaigns, failed} = await readCampaigns(admin, shop);
  const now = campaignOf(campaigns, qrCodeId);
  const drifted = now && !touched.some((t) => t.gid === now.gid);
  const touchedNow = campaigns.filter((campaign) => touched.some((t) => t.gid === campaign.gid));
  const started = touchedNow.find((campaign) => campaign.status !== 'planned');
  const held = touchedNow.map(heldByTargets).find(Boolean);
  const problems = failed.length
    ? failed
    : drifted
      ? [
          {
            code: 'STALE',
            message: 'This QR code changed while you were working. Reload the page and try again.',
          },
        ]
      : started
        ? [
            {
              code: 'NOT_PLANNED',
              message: `${started.title} is ${statusLabel(started.status).toLowerCase()}. QR codes move only between planned campaigns.`,
            },
          ]
        : held
          ? [{code: 'HAS_TARGETS', message: held}]
          : [];
  if (problems.length) {
    await lock.release();
    return {problems};
  }
  return lock;
}

export const campaignOf = (campaigns, qrCodeId) =>
  campaigns.find((campaign) =>
    campaign.qrCodes.some((qrCode) => qrCode.id === qrCodeId),
  ) ?? null;
// [END campaign-dashboard.qr-assign]

// [START campaign-dashboard.campaign-lock]
// Two requests can read one campaign as planned and both activate it. A row in the app's
// database holds the campaign until the first request finishes.
const HELD = 'Another change to this campaign is in progress. Reload in a moment.';

export async function lockCampaign(shop, campaignId) {
  const id = Number.parseInt(campaignId, 10) || 0;
  let owner;
  try {
    owner = await takeLock(shop, id);
  } catch (error) {
    console.error('Could not take the campaign lock', error);
    return {problems: [{message: "Couldn't lock the campaign. Try again."}]};
  }
  if (!owner) return {problems: [{message: HELD}]};

  // A failed release logs and returns. The write it guarded has already answered.
  const release = async () => {
    try {
      await releaseLock(shop, id, owner);
    } catch (error) {
      console.error('Could not release the campaign lock', error);
    }
  };
  return {release};
}

// Takes each campaign's lock in turn. One held lock releases the rest and refuses.
export async function lockCampaigns(shop, campaignIds) {
  const locks = [];
  for (const id of [...new Set(campaignIds)]) {
    const lock = await lockCampaign(shop, id);
    if (lock.problems) {
      for (const taken of locks) await taken.release();
      return {problems: lock.problems};
    }
    locks.push(lock);
  }
  return {
    release: async () => {
      for (const lock of locks) await lock.release();
    },
  };
}
// [END campaign-dashboard.campaign-lock]

// [START campaign-dashboard.seed-campaign]
// Both start planned. One starts mid-flight with targets, the other weeks out without.
function seedRecords() {
  const day = (date) => date.toISOString().slice(0, 10);
  const shift = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return day(date);
  };

  return [
    {
      id: FIRST_CAMPAIGN_ID,
      title: 'Summer launch',
      // Dated 20 days in with a week left. Activate it and the nine sends land over the
      // first two weeks, leaving room for the sales they moved.
      startDate: shift(-20),
      endDate: shift(7),
      channels: ['email', 'sms', 'push'],
      audience: 'vip',
      // Two belong to one creator, the pairing no built-in dimension holds.
      creatorPairs: [
        {code: 'AVERY10', creator: 'Avery'},
        {code: 'AVERYSUMMER', creator: 'Avery'},
        {code: 'JUNO15', creator: 'Juno'},
      ],
      revenueTarget: '10000.00',
      productTarget: '4000.00',
      audienceTarget: '5000.00',
      status: 'planned',
    },
    // Starting in the future, with no targets. Every panel shows the setup it still needs.
    {
      id: FIRST_CAMPAIGN_ID + 1,
      title: 'Back to school',
      startDate: shift(14),
      endDate: shift(35),
      channels: ['email', 'sms'],
      audience: 'regulars',
      status: 'planned',
    },
  ];
}

export async function ensureCampaign(admin, shop) {
  const {userErrors: missing} = await ensureDefinition(admin);
  const state = await readCampaigns(admin, shop);
  if (missing.length) return {...state, userErrors: missing};
  // Seeding on a failed read would write over campaigns already stored.
  if (state.failed.length) return {...state, userErrors: state.failed};
  if (state.campaigns.length > 0) return {...state, userErrors: []};
  // Seed once per shop. Spent IDs mean the seeds went out already, and the merchant
  // deleted them.
  try {
    if (await hasSpentIds(shop)) return {...state, userErrors: []};
  } catch (error) {
    console.error('Could not read campaign IDs', error);
    return {...state, userErrors: [{message: "Couldn't read the app's campaign records. Try again."}]};
  }

  // Upsert on fixed handles. Two first loads racing each other write the same entries.
  const seeded = await Promise.all(
    seedRecords().map(async ({creatorPairs, ...seed}) => {
      if (creatorPairs) {
        const {creators, userErrors} = await upsertCreators(admin, creatorPairs);
        if (userErrors.length) return {campaign: null, userErrors};
        seed.creators = creators;
      }
      return entryResult(
        await (
          await admin.graphql(CAMPAIGN_UPSERT, {
            variables: {
              handle: {type: CAMPAIGN_TYPE, handle: campaignHandle(seed.id)},
              metaobject: {fields: campaignFields(seed)},
            },
          })
        ).json(),
        'metaobjectUpsert',
      );
    }),
  );
  const userErrors = seeded.flatMap((result) => result.userErrors);
  if (userErrors.length === 0) {
    try {
      await spendThrough(shop, FIRST_CAMPAIGN_ID + 1);
    } catch (error) {
      console.error('Could not save campaign IDs', error);
      userErrors.push({message: "Couldn't save the app's campaign records. Try again."});
    }
  }
  const campaigns = seeded
    .map((result) => result.campaign && withState(result.campaign, shop, null))
    .filter(Boolean);
  return {...state, campaigns, userErrors};
}
// [END campaign-dashboard.seed-campaign]

// [START campaign-dashboard.spawn-campaign]
// Every App Events filter keys on the ID. It has to be an integer, and it has to be new.
export async function createCampaign(admin, shop, fields) {
  const {campaigns, failed} = await readCampaigns(admin, shop);
  // A failed read hands out an ID that already has App Events data behind it.
  if (failed.length) return {campaign: null, userErrors: failed};

  let id = campaignIdFloor(campaigns);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Spend the ID before using it. A failed create then skips the ID.
    try {
      id = await allocateCampaignId(shop, id);
    } catch (error) {
      console.error('Could not allocate a campaign ID', error);
      return {campaign: null, userErrors: [{message: "Couldn't assign a campaign ID. Try again."}]};
    }

    const handle = campaignHandle(id);
    const body = await (
      await admin.graphql(CAMPAIGN_CREATE, {
        variables: {
          metaobject: {
            type: CAMPAIGN_TYPE,
            handle,
            fields: campaignFields({
              audience: 'everyone',
              ...fields,
              id,
              status: 'planned',
            }),
          },
        },
      })
    ).json();
    const result = entryResult(body, 'metaobjectCreate');
    if (!result.campaign) return result;
    // Shopify suffixes a taken handle without an error. An entry the database doesn't
    // know about holds this ID.
    if (result.campaign.handle === handle) {
      return {...result, campaign: withState(result.campaign, shop, null)};
    }
    const cleanup = await deleteCampaign(admin, result.campaign);
    if (cleanup.userErrors.length) return {campaign: null, userErrors: cleanup.userErrors};
  }
  return {
    campaign: null,
    userErrors: [{message: "Couldn't assign a campaign ID. Try again."}],
  };
}
// [END campaign-dashboard.spawn-campaign]

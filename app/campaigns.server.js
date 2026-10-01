import {AUDIENCE_TIERS} from './audiences';
import {
  CAMPAIGN_BY_ID,
  CAMPAIGN_CREATE,
  CAMPAIGN_DEFINITION_CREATE,
  CAMPAIGN_DEFINITION_QUERY,
  CAMPAIGN_FIELDS_ADD,
  CAMPAIGN_DELETE,
  CAMPAIGN_TYPE,
  CAMPAIGN_UPDATE,
  CAMPAIGN_UPSERT,
  CAMPAIGNS_QUERY,
  ID_KEY,
  ID_NAMESPACE,
  METAFIELDS_SET,
  QR_CODE_HANDLES,
} from './campaign-queries.server';
import {CHANNELS} from './channels';
import {sanitizeCode} from './campaigns';

// [START campaign-dashboard.campaign-ids]
// IDs stay spent. Event data can't be deleted, and a reused ID inherits its funnel.
export const FIRST_CAMPAIGN_ID = 4210;

// The handle is the entry's lookup key. The integer is what App Events filters on.
export const campaignHandle = (id) => `campaign-${id}`;

// Count past the high-water mark. The highest stored ID alone forgets a deleted campaign.
export const nextCampaignId = (campaigns, highWater) =>
  campaigns.reduce(
    (highest, campaign) => Math.max(highest, Number(campaign.id) || 0),
    Math.max(FIRST_CAMPAIGN_ID - 1, Number(highWater) || 0),
  ) + 1;
// [END campaign-dashboard.campaign-ids]

// [START campaign-dashboard.campaign-store]
// Every query, target, and annotation on the dashboard derives from these fields.
// Each campaign is an entry the merchant can open in the admin. Descriptions show there.
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
  // IDs as text. A reference field would validate against the QR code type, and
  // Shopify drops that field when an uninstall deletes the type.
  {
    field: 'qrCodes',
    key: 'qr_code_ids',
    name: 'QR code IDs',
    type: 'list.single_line_text_field',
    validations: [{name: 'list.max', value: '50'}],
    description: 'The codes assigned to this campaign. A code belongs to one campaign.',
  },
  {
    field: 'audience',
    key: 'audience',
    name: 'Customer segment',
    type: 'single_line_text_field',
    validations: choices(AUDIENCE_TIERS.map((tier) => tier.value)),
    description: 'Tier value written onto each targeted customer at activation.',
  },
  {
    field: 'members',
    key: 'members',
    name: 'Tier members',
    type: 'list.customer_reference',
    description: 'Customers who got the segment metafield at activation. Redaction removes them.',
  },
  {
    field: 'creatorCodes',
    key: 'creator_codes',
    name: 'Creator codes',
    type: 'json',
    description:
      'Each discount code and the creator who shares it.',
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
  {
    field: 'markers',
    key: 'markers',
    name: 'Annotation IDs',
    type: 'json',
    description: 'IDs of annotations this app created.',
  },
  {
    field: 'targets',
    key: 'targets',
    name: 'Target IDs',
    type: 'json',
    description:
      'IDs of targets this app created. Cancel deletes only these.',
  },
  {
    field: 'sentEvents',
    key: 'sent_events',
    name: 'Sent events',
    type: 'number_integer',
    validations: atLeastZero,
    description: 'Number of App Events sent. A recorded count blocks a second send.',
  },
];
// [END campaign-dashboard.campaign-store]

// [START campaign-dashboard.campaign-definition]
const fieldInput = ({field, ...definition}) => definition;

// A field added after the first install reaches existing stores on the next load.
async function addMissingFields(admin, campaign) {
  const keys = new Set(campaign.fieldDefinitions.map((field) => field.key));
  const missing = CAMPAIGN_FIELDS.filter((definition) => !keys.has(definition.key));
  if (!missing.length) return {definitionId: campaign.id, userErrors: []};

  const body = await (
    await admin.graphql(CAMPAIGN_FIELDS_ADD, {
      variables: {
        id: campaign.id,
        definition: {
          fieldDefinitions: missing.map((definition) => ({create: fieldInput(definition)})),
        },
      },
    })
  ).json();
  const userErrors = [
    ...transportErrors(body),
    ...(body.data?.metaobjectDefinitionUpdate?.userErrors ?? []),
  ];
  return {definitionId: userErrors.length ? null : campaign.id, userErrors};
}

export async function ensureDefinition(admin) {
  const read = async () =>
    (
      await admin.graphql(CAMPAIGN_DEFINITION_QUERY, {
        variables: {type: CAMPAIGN_TYPE},
      })
    ).json();

  const body = await read();
  const failed = transportErrors(body);
  if (failed.length) return {definitionId: null, userErrors: failed};

  const campaign = body.data?.campaign;
  if (campaign) return addMissingFields(admin, campaign);

  const created = await (
    await admin.graphql(CAMPAIGN_DEFINITION_CREATE, {
      variables: {
        definition: {
          type: CAMPAIGN_TYPE,
          name: 'Campaign',
          description: 'Marketing campaigns planned in the campaign dashboard app.',
          displayNameKey: 'title',
          fieldDefinitions: CAMPAIGN_FIELDS.map(fieldInput),
        },
      },
    })
  ).json();

  const result = created.data?.metaobjectDefinitionCreate;
  if (result?.metaobjectDefinition) {
    return {definitionId: result.metaobjectDefinition.id, userErrors: []};
  }
  // Two first loads race to create it. The loser finds the winner's definition.
  const again = await read();
  if (again.data?.campaign) return {definitionId: again.data.campaign.id, userErrors: []};
  return {
    definitionId: null,
    userErrors: [...transportErrors(created), ...(result?.userErrors ?? [])],
  };
}
// [END campaign-dashboard.campaign-definition]

// [START campaign-dashboard.campaign-read]
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
    // readCampaigns looks up each code's handle, title, and live date.
    qrCodes: listOf(values.qr_code_ids)
      .filter((id) => /^gid:\/\/shopify\/Metaobject\/\d+$/.test(id))
      .map((id) => ({id, handle: null, title: '', liveOn: ''})),
    audience: values.audience ?? 'everyone',
    members: listOf(values.members),
    // Entries are editable in the admin. Codes reach ShopifyQL filters.
    creatorCodes: listOf(values.creator_codes)
      .filter((pair) => isRecord(pair) && pair.code && pair.creator)
      .map((pair) => ({code: sanitizeCode(pair.code), creator: String(pair.creator)})),
    revenueTarget: values.revenue_target ?? '',
    productTarget: values.product_target ?? '',
    audienceTarget: values.audience_target ?? '',
    qrTarget: values.qr_target ?? '',
    status: values.status ?? 'planned',
    markers: isRecord(values.markers) ? values.markers : {},
    targets: isRecord(values.targets) ? values.targets : {},
    sentEvents: values.sent_events ?? null,
  };
}

// A deleted code's ID resolves to null, and the campaign drops it.
async function withQRHandles(admin, campaigns) {
  const ids = [...new Set(campaigns.flatMap((campaign) => campaign.qrCodes.map((qrCode) => qrCode.id)))];
  const handles = new Map();
  for (let start = 0; start < ids.length; start += 250) {
    const body = await (
      await admin.graphql(QR_CODE_HANDLES, {variables: {ids: ids.slice(start, start + 250)}})
    ).json();
    const failed = transportErrors(body);
    if (failed.length) return failed;
    for (const node of body.data?.nodes ?? []) {
      if (node?.handle) {
        handles.set(node.id, {
          handle: node.handle,
          title: node.title?.value ?? '',
          liveOn: node.liveOn?.value ?? '',
        });
      }
    }
  }
  for (const campaign of campaigns) {
    campaign.qrCodes = campaign.qrCodes
      .filter((qrCode) => handles.has(qrCode.id))
      .map((qrCode) => ({id: qrCode.id, ...handles.get(qrCode.id)}));
  }
  return [];
}

// Returns this app's ID alongside the records. The namespace derives from it.
export async function readCampaigns(admin) {
  const campaigns = [];
  let installation = null;
  let failed = [];
  let after = null;

  // 250 per page, up to 20 pages.
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
  }

  if (!failed.length) failed = await withQRHandles(admin, campaigns);

  return {
    // An empty list from a failed read is indistinguishable from a store with no
    // campaigns. Seeding and ID allocation refuse on a failed read.
    failed,
    appId: installation?.app?.id ?? null,
    // The value `app_name` holds in App Events. Every app writes it.
    appName: installation?.app?.title ?? null,
    installationId: installation?.id ?? null,
    highWater: Number(installation?.metafield?.value) || null,
    campaigns: failed.length ? [] : campaigns.sort((first, second) => first.id - second.id),
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
  // Products and QR codes travel as records. The field stores their IDs.
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

// A write touches one entry. Two writes to different campaigns never collide.
export async function updateCampaign(admin, campaign, change) {
  const body = await (
    await admin.graphql(CAMPAIGN_UPDATE, {
      variables: {id: campaign.gid, metaobject: {fields: campaignFields(change)}},
    })
  ).json();
  return entryResult(body, 'metaobjectUpdate');
}

// Annotation IDs per mark, to find and rewrite an annotation after the campaign runs.
// Re-read first. Each ID lands as its mark saves, and the record in hand is stale.
export async function rememberMarkers(admin, campaign, markers) {
  const body = await (
    await admin.graphql(CAMPAIGN_BY_ID, {variables: {id: campaign.gid}})
  ).json();
  const failed = transportErrors(body);
  if (failed.length) return {campaign: null, userErrors: failed};
  const current = body.data?.metaobject
    ? campaignFromNode(body.data.metaobject)
    : campaign;
  return updateCampaign(admin, campaign, {
    markers: {...current.markers, ...markers},
  });
}
// [END campaign-dashboard.campaign-write]

// The route gates the delete to canceled campaigns. Cancel removes the annotations
// and targets. Shopify drops the product references to a deleted entry.
export async function deleteCampaign(admin, campaign) {
  const body = await (
    await admin.graphql(CAMPAIGN_DELETE, {variables: {id: campaign.gid}})
  ).json();
  const failed = transportErrors(body);
  if (failed.length) return {userErrors: failed};
  return {userErrors: body.data?.metaobjectDelete?.userErrors ?? []};
}

// The tier members are the only customer data this app stores. Shopify deletes the
// tier metafield with the customer. Clearing the member lists is this app's job.
export async function forgetCustomer(admin, customerId) {
  const {campaigns, failed} = await readCampaigns(admin);
  if (failed.length) return failed;

  const userErrors = [];
  for (const campaign of campaigns) {
    if (!campaign.members.includes(customerId)) continue;
    const result = await updateCampaign(admin, campaign, {
      members: campaign.members.filter((member) => member !== customerId),
    });
    userErrors.push(...result.userErrors);
  }
  return userErrors;
}

// [START campaign-dashboard.qr-assign]
// A code belongs to one campaign. Assigning it drops it from every other campaign.
export async function assignQRCode(admin, qrCodeId, campaignGid) {
  const {campaigns, failed} = await readCampaigns(admin);
  if (failed.length) return failed;

  // The new campaign first. A failure partway leaves the code on two campaigns, not none.
  const ordered = [...campaigns].sort(
    (a, b) => (b.gid === campaignGid) - (a.gid === campaignGid),
  );
  const userErrors = [];
  for (const campaign of ordered) {
    const has = campaign.qrCodes.some((qrCode) => qrCode.id === qrCodeId);
    const wants = campaign.gid === campaignGid;
    if (has === wants) continue;
    const qrCodes = wants
      ? has
        ? campaign.qrCodes
        : [...campaign.qrCodes, {id: qrCodeId}]
      : campaign.qrCodes.filter((qrCode) => qrCode.id !== qrCodeId);
    const result = await updateCampaign(admin, campaign, {qrCodes});
    userErrors.push(...result.userErrors);
  }
  return userErrors;
}

export const campaignOf = (campaigns, qrCodeId) =>
  campaigns.find((campaign) =>
    campaign.qrCodes.some((qrCode) => qrCode.id === qrCodeId),
  ) ?? null;
// [END campaign-dashboard.qr-assign]

async function setHighWater(admin, installationId, id) {
  const body = await (
    await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId: installationId,
            namespace: ID_NAMESPACE,
            key: ID_KEY,
            type: 'number_integer',
            value: String(id),
          },
        ],
      },
    })
  ).json();
  const failed = transportErrors(body);
  if (failed.length) return failed;
  return body.data?.metafieldsSet?.userErrors ?? [];
}

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
      creatorCodes: [
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

export async function ensureCampaign(admin) {
  const {userErrors: missing} = await ensureDefinition(admin);
  const state = await readCampaigns(admin);
  if (missing.length) return {...state, userErrors: missing};
  // Seeding on a failed read would write over campaigns already stored.
  if (state.failed.length) return {...state, userErrors: state.failed};
  // Seed once per store. A high-water mark means the seed IDs went out already.
  if (state.highWater || state.campaigns.length > 0) return {...state, userErrors: []};

  // Upsert on fixed handles. Two first loads racing each other write the same two entries.
  const seeded = await Promise.all(
    seedRecords().map(async (seed) =>
      entryResult(
        await (
          await admin.graphql(CAMPAIGN_UPSERT, {
            variables: {
              handle: {type: CAMPAIGN_TYPE, handle: campaignHandle(seed.id)},
              metaobject: {fields: campaignFields(seed)},
            },
          })
        ).json(),
        'metaobjectUpsert',
      ),
    ),
  );
  const userErrors = seeded.flatMap((result) => result.userErrors);
  if (userErrors.length === 0) {
    userErrors.push(
      ...(await setHighWater(admin, state.installationId, FIRST_CAMPAIGN_ID + 1)),
    );
  }
  const campaigns = seeded.map((result) => result.campaign).filter(Boolean);
  return {...state, campaigns, highWater: FIRST_CAMPAIGN_ID + 1, userErrors};
}
// [END campaign-dashboard.seed-campaign]

// [START campaign-dashboard.spawn-campaign]
// Every App Events filter keys on the ID. It has to be an integer, and it has to be new.
export async function createCampaign(admin, fields) {
  const {installationId, campaigns, highWater, failed} = await readCampaigns(admin);
  // A failed read hands out an ID that already has App Events data behind it.
  if (failed.length) return {campaign: null, userErrors: failed};

  let id = nextCampaignId(campaigns, highWater);
  for (let attempt = 0; attempt < 5; attempt += 1, id += 1) {
    // Spend the ID before using it. A failed create skips the ID instead of reusing it.
    const unsaved = await setHighWater(admin, installationId, id);
    if (unsaved.length) return {campaign: null, userErrors: unsaved};

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
    // A taken handle gets a suffix, not an error. Another request claimed this ID.
    if (result.campaign.handle === handle) return result;
    const cleanup = await deleteCampaign(admin, result.campaign);
    if (cleanup.userErrors.length) return {campaign: null, userErrors: cleanup.userErrors};
  }
  return {
    campaign: null,
    userErrors: [{message: "Couldn't assign a campaign ID. Try again."}],
  };
}
// [END campaign-dashboard.spawn-campaign]

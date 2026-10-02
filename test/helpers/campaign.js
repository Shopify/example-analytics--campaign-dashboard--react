import {CAMPAIGN_FIELDS, campaignFields} from '../../app/campaigns.server';

export const INSTALLATION = {id: 'gid://shopify/AppInstallation/1', app: {id: 'gid://shopify/App/7', title: 'Campaign dashboard'}};

// An entry as the list query returns it, built from a camelCase campaign.
export function node({gid = 'gid://shopify/Metaobject/1', handle, updatedAt, products = [], qrCodes = [], ...fields}) {
  return {
    id: gid,
    updatedAt,
    handle: handle ?? `campaign-${fields.id}`,
    fields: campaignFields({...fields, products, qrCodes}).map(({key, value}) => ({key, jsonValue: decode(key, value)})),
    products: {references: {nodes: products}},
    // The handle lookup answers from these. The entry stores only the IDs.
    qrCodeNodes: qrCodes,
  };
}

// The API hands back JSON for lists and json fields, a number for integers, strings otherwise.
function decode(key, value) {
  if (value === '') return null;
  if (['channels', 'products', 'qr_code_ids', 'creator_codes', 'markers', 'targets'].includes(key)) {
    return JSON.parse(value);
  }
  if (key === 'campaign_id' || key === 'sent_events') return Number(value);
  return value;
}

// Answers the handle lookup for the given codes. An unknown ID resolves to null.
export const qrCodeHandles = (codes) => ({ids}) => ({
  data: {nodes: ids.map((id) => codes.find((code) => code.id === id) ?? null)},
});

export const handlesFor = (entries) => qrCodeHandles(entries.flatMap((entry) => entry.qrCodeNodes ?? []));

// Every key the app defines, as a stored definition lists them.
export const ALL_FIELDS = CAMPAIGN_FIELDS.map(({key}) => ({key}));

export const listOf = (nodes, metafield = null) => () => ({
  data: {
    currentAppInstallation: {...INSTALLATION, metafield},
    metaobjects: {nodes, pageInfo: {hasNextPage: false, endCursor: null}},
  },
});

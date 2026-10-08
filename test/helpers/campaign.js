import {CAMPAIGN_FIELDS, CREATOR_FIELDS, campaignFields} from '../../app/campaigns.server';
import {seedState} from './db';

export const INSTALLATION = {id: 'gid://shopify/AppInstallation/1', app: {id: 'gid://shopify/App/7', title: 'Campaign dashboard'}};

// An entry as the list query returns it, built from a camelCase campaign. Markers, targets,
// and a send count go to the app's database for the test shop, where the app keeps them.
export function node({gid = 'gid://shopify/Metaobject/1', handle, products = [], qrCodes = [], creators, markers, targets, sentEvents, ...fields}) {
  if (markers || targets || sentEvents != null) seedState({campaignId: fields.id, gid, markers, targets, sentEvents});
  return {
    id: gid,
    handle: handle ?? `campaign-${fields.id}`,
    fields: campaignFields({...fields, products, ...(creators && {creators})}).map(({key, value}) => ({key, jsonValue: decode(key, value)})),
    products: {references: {nodes: products}},
    creators: creators && {references: {nodes: creators.map(creatorNode)}},
    // The QR code list answers from these. Each code names the entry in its own field.
    qrCodeNodes: qrCodes,
  };
}

// The API hands back JSON for lists and json fields, a number for integers, strings otherwise.
function decode(key, value) {
  if (value === '') return null;
  if (['channels', 'products', 'creators'].includes(key)) return JSON.parse(value);
  if (key === 'campaign_id') return Number(value);
  return value;
}

// A QR code entry as the list read returns it. `campaign` is the GID its field holds.
export const qrCodeNode = ({id, handle, title, liveOn, campaign}) => ({
  id,
  handle,
  title: title ? {value: title} : null,
  liveOn: liveOn ? {value: liveOn} : null,
  campaign: campaign ? {value: campaign} : null,
});

// Answers the QR code list read with the given code entries, one page.
export const qrCodeList = (nodes) => () => ({
  data: {metaobjects: {nodes, pageInfo: {hasNextPage: false, endCursor: null}}},
});

// Each entry's codes, with the `campaign` field pointing back at the entry.
export const qrCodesFor = (entries) =>
  qrCodeList(entries.flatMap((entry) => (entry.qrCodeNodes ?? []).map((code) => qrCodeNode({...code, campaign: entry.id}))));

// A Creator entry as a reference list or a handle lookup returns it.
export const creatorNode = ({id, handle, name, codes = []}) => ({
  id,
  handle,
  fields: [
    {key: 'name', jsonValue: name},
    {key: 'discount_codes', jsonValue: codes},
  ],
});

// Every key the app defines, as a stored definition lists them.
export const ALL_FIELDS = CAMPAIGN_FIELDS.map(({key}) => ({key}));
export const CREATOR_KEYS = CREATOR_FIELDS.map(({key}) => ({key}));

// Answers the definition read for both types. A null leaves that type to create.
export const objectDefinitions = ({creator = {id: 'creator-def', fieldDefinitions: CREATOR_KEYS}, campaign = {id: 'def', fieldDefinitions: ALL_FIELDS}} = {}) =>
  ({type}) => ({data: {definition: type === 'campaign_dashboard_creator' ? creator : campaign}});

export const listOf = (nodes) => () => ({
  data: {
    currentAppInstallation: INSTALLATION,
    metaobjects: {nodes, pageInfo: {hasNextPage: false, endCursor: null}},
  },
});

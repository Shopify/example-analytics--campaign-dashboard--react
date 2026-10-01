import {mockAdmin} from './admin';
import {handlesFor, listOf, node} from './campaign';

// The mocked `authenticate.admin` hands each route the admin a test installs here.
export const session = {admin: null};

export const shopifyServer = {
  authenticate: {
    admin: async () => ({
      admin: session.admin,
      session: {shop: 'example.test'},
      redirect: (url) => new Response(null, {status: 302, headers: {Location: url}}),
    }),
  },
};

export const post = (path, fields) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request(`https://app.test${path}`, {method: 'POST', body});
};

export const planned = (overrides = {}) =>
  node({
    gid: 'gid://shopify/Metaobject/1',
    id: 4210,
    title: 'Summer launch',
    startDate: '2026-09-10',
    endDate: '2026-10-07',
    channels: ['email'],
    audience: 'everyone',
    status: 'planned',
    ...overrides,
  });

// Every read the campaign action makes before it reaches an intent.
export const base = (entry) => ({
  CampaignList: listOf([entry]),
  QRCodeHandles: handlesFor([entry]),
  CampaignShop: () => ({data: {shop: {id: 'gid://shopify/Shop/1', ianaTimezone: 'Etc/UTC', currencyCode: 'USD'}}}),
  AppMetafieldDefinitions: () => ({data: {products: {nodes: []}, customers: {nodes: []}, orders: {nodes: []}}}),
  UpdateCampaign: () => ({data: {metaobjectUpdate: {metaobject: null, userErrors: []}}}),
  CampaignById: () => ({data: {metaobject: entry}}),
});

export const marking = {
  CampaignAnnotations: () => ({data: {shop: {analyticsAnnotations: {nodes: [], pageInfo: {hasNextPage: false}}}}}),
  CreateCampaignAnnotation: () => ({
    data: {analyticsAnnotationCreate: {analyticsAnnotation: {id: `gid://shopify/AnalyticsAnnotation/${Math.random()}`}, userErrors: []}},
  }),
};

let targetCount = 0;
export const resetTargets = () => {
  targetCount = 0;
};
export const targeting = {
  CreateCampaignTarget: () => ({
    data: {analyticsTargetCreate: {analyticsTarget: {id: `gid://shopify/AnalyticsTarget/${++targetCount}`}, userErrors: []}},
  }),
  DeleteCampaignTargets: () => ({data: {analyticsTargetsDelete: {userErrors: []}}}),
};

export const runWith = (action) => (handlers, fields, path = '/app/campaigns/4210') => {
  const mock = mockAdmin(handlers);
  session.admin = mock.admin;
  return {mock, result: action({request: post(path, fields), params: {campaignId: '4210'}})};
};

export const lastUpdate = (calls) =>
  Object.fromEntries(
    calls.filter((call) => call.op === 'UpdateCampaign').at(-1).variables.metaobject.fields.map((field) => [field.key, field.value]),
  );

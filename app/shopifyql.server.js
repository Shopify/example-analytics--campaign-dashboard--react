// [START campaign-dashboard.shopifyql-throttle]
// A throttled query returns THROTTLED, and `windowResetAt` says when the ShopifyQL budget
// refills. Wait and retry once, unless the wait would hold the request open too long.
export const MAX_THROTTLE_WAIT_MS = 10_000;
// The standard API budget throttles too, without a `windowResetAt`.
const UNKNOWN_RESET_WAIT_MS = 1_000;

const isThrottled = (body) =>
  (body.errors ?? []).some((error) => error.extensions?.code === 'THROTTLED');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function queryShopifyQL(admin, query) {
  const body = await (await admin.graphql(query)).json();
  if (!isThrottled(body)) return body;

  const resetAt = Date.parse(body.extensions?.shopifyqlCost?.windowResetAt ?? '');
  const wait = Number.isNaN(resetAt) ? UNKNOWN_RESET_WAIT_MS : Math.max(0, resetAt - Date.now());
  if (wait > MAX_THROTTLE_WAIT_MS) {
    const at = new Date(resetAt).toISOString().slice(11, 19);
    return {
      ...body,
      errors: [{message: `This store's ShopifyQL budget refills at ${at} UTC. Try again then.`, extensions: {code: 'THROTTLED'}}],
    };
  }
  await pause(wait);
  return (await admin.graphql(query)).json();
}
// [END campaign-dashboard.shopifyql-throttle]

// A parse error answers 200 with null `tableData`. Check both fields before reading rows.
export const shopifyqlErrors = (body, field = 'shopifyqlQuery') => [
  ...(body.errors ?? []).map((error) => ({message: error.message})),
  ...(body.data?.[field]?.parseErrors ?? []).map((message) => ({message})),
];

// [START campaign-dashboard.shopifyql-throttle]
// A query over the ShopifyQL budget gets HTTP 429, and the library drops that response's
// body. Successful responses carry `windowResetAt`, the time the budget refills. Keep the
// latest one per request client, wait until then, and retry once.
export const MAX_THROTTLE_WAIT_MS = 10_000;
// With no refill time seen yet, wait a second.
const UNKNOWN_RESET_WAIT_MS = 1_000;
const resets = new WeakMap();

const isThrottled = (body) =>
  (body.errors ?? []).some((error) => error.extensions?.code === 'THROTTLED');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(admin, query) {
  const body = await (await admin.graphql(query)).json();
  const resetAt = body.extensions?.shopifyqlCost?.windowResetAt;
  if (resetAt) resets.set(admin, resetAt);
  return body;
}

export async function queryShopifyQL(admin, query) {
  const body = await run(admin, query);
  if (!isThrottled(body)) return body;

  const resetAt = Date.parse(resets.get(admin) ?? '');
  const wait = Number.isNaN(resetAt) ? UNKNOWN_RESET_WAIT_MS : Math.max(0, resetAt - Date.now());
  if (wait > MAX_THROTTLE_WAIT_MS) {
    const at = new Date(resetAt).toISOString().slice(11, 19);
    return {
      ...body,
      errors: [{message: `This store's ShopifyQL budget refills at ${at} UTC. Try again then.`, extensions: {code: 'THROTTLED'}}],
    };
  }
  await pause(wait);
  return run(admin, query);
}
// [END campaign-dashboard.shopifyql-throttle]

// A parse error answers 200 with null `tableData`. Check both fields before reading rows.
export const shopifyqlErrors = (body, field = 'shopifyqlQuery') => [
  ...(body.errors ?? []).map((error) => ({message: error.message})),
  ...(body.data?.[field]?.parseErrors ?? []).map((message) => ({message})),
];

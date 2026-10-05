import {withReturnedErrors} from '../../app/campaigns.server';

// A stand-in for `admin.graphql`. Routes each document by its operation name and
// throws on any operation without a handler.
// A body with top-level `errors` throws the way `GraphqlQueryError` does. `admin` is
// wrapped like a route wraps it. Route tests install `raw` to prove the route wraps.
export function mockAdmin(handlers) {
  const calls = [];
  const graphql = async (document, {variables} = {}) => {
    const op = document.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    calls.push({op, variables});
    const handler = handlers[op];
    if (!handler) throw new Error(`No handler for ${op ?? 'anonymous operation'}`);
    const body = await handler(variables ?? {}, calls);
    if (body?.errors?.length) {
      const error = new Error(body.errors[0].message);
      error.body = {data: body.data ?? null, errors: {graphQLErrors: body.errors}};
      throw error;
    }
    return {json: async () => body};
  };
  const raw = {graphql};
  return {admin: withReturnedErrors(raw), raw, calls};
}

export const ops = (calls) => calls.map((call) => call.op);

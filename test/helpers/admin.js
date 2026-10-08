import {withReturnedErrors} from '../../app/campaigns.server';
import {qrCodeList} from './campaign';

// A stand-in for `admin.graphql`. Routes each document by its operation name and
// throws on any operation without a handler. The QR code list defaults to no codes.
// A body with top-level `errors` throws the way `GraphqlQueryError` does, and a handler's
// `Response` throws the way an HTTP error does. Route tests install `raw` to prove the route wraps.
const DEFAULTS = {CampaignQRCodes: qrCodeList([])};

export function mockAdmin(handlers) {
  const calls = [];
  const graphql = async (document, {variables} = {}) => {
    const op = document.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    calls.push({op, variables});
    const handler = handlers[op] ?? DEFAULTS[op];
    if (!handler) throw new Error(`No handler for ${op ?? 'anonymous operation'}`);
    const body = await handler(variables ?? {}, calls);
    if (body instanceof Response) throw body;
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

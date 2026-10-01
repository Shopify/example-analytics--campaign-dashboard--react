// A stand-in for `admin.graphql`. Routes each document by its operation name and
// throws on any operation without a handler.
export function mockAdmin(handlers) {
  const calls = [];
  const graphql = async (document, {variables} = {}) => {
    const op = document.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    calls.push({op, variables});
    const handler = handlers[op];
    if (!handler) throw new Error(`No handler for ${op ?? 'anonymous operation'}`);
    const body = await handler(variables ?? {}, calls);
    return {json: async () => body};
  };
  return {admin: {graphql}, calls};
}

export const ops = (calls) => calls.map((call) => call.op);

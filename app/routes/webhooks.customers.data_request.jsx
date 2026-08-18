import {authenticate} from '../shopify.server';

// A customer asking for a copy of what this app holds on them. Shopify forwards the
// request and the app answers the merchant directly, inside 30 days.
export const action = async ({request}) => {
  const {shop, topic} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  return new Response();
};

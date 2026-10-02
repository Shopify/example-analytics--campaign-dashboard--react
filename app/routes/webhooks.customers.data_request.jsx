import {authenticate} from '../shopify.server';
import {customerTier} from '../campaigns.server';

// A customer asking for a copy of what this app holds on them. The tier metafield is
// all of it. The app sends that to the merchant inside 30 days. This sample logs it.
export const action = async ({request}) => {
  const {admin, shop, topic, payload} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  const id = payload.customer?.id;
  if (!admin || !id) return new Response();

  const {tier, userErrors} = await customerTier(admin, `gid://shopify/Customer/${id}`);
  if (userErrors.length) {
    console.error(userErrors.map((error) => error.message).join('. '));
  } else {
    console.log(`Customer ${id} holds tier ${tier ? `"${tier}"` : 'none'} from this app`);
  }

  return new Response();
};

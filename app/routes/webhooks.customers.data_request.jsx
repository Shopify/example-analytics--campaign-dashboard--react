import {authenticate} from '../shopify.server';
import {customerTier, withReturnedErrors} from '../campaigns.server';

// A customer asking for a copy of what this app holds on them. That's the tier metafield
// and the campaigns that list them. The app sends both to the merchant inside 30 days.
// This sample logs them.
export const action = async ({request}) => {
  const {admin, shop, topic, payload} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  const id = payload.customer?.id;
  if (!admin || !id) return new Response();

  const {tier, campaigns, userErrors} = await customerTier(
    withReturnedErrors(admin),
    `gid://shopify/Customer/${id}`,
  );
  if (userErrors.length) {
    console.error(userErrors.map((error) => error.message).join('. '));
  } else {
    console.log(`Customer ${id} holds tier ${tier ? `"${tier}"` : 'none'} from this app`);
    console.log(`Campaigns listing customer ${id}: ${campaigns.join(', ') || 'none'}`);
  }

  return new Response();
};

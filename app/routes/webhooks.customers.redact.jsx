import {authenticate} from '../shopify.server';
import {forgetCustomer, withReturnedErrors} from '../campaigns.server';

// Activating a targeted campaign writes a tier metafield on each customer in the tier
// and lists them on the campaign entry. Redaction deletes both.
export const action = async ({request}) => {
  const {admin, shop, topic, payload} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  // Without a session the app can't reach the store.
  if (!admin) return new Response();

  const id = payload.customer?.id;
  if (!id) return new Response();

  const errors = await forgetCustomer(withReturnedErrors(admin), `gid://shopify/Customer/${id}`);
  // A 200 confirms receipt, and that's all a compliance webhook owes. The 30 days to
  // finish belong to the app, and a real app would queue this retry.
  if (errors.length) {
    console.error(errors.map((error) => error.message).join('. '));
  }

  return new Response();
};

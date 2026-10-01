import {authenticate} from '../shopify.server';
import {forgetCustomer} from '../campaigns.server';

// Activating a campaign saves a reference to each tier member on the campaign entry.
// Redaction has to reach that too.
export const action = async ({request}) => {
  const {admin, shop, topic, payload} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  // Without a session the app can't reach the store. The merchant can still delete
  // the campaign entries in the admin.
  if (!admin) return new Response();

  const id = payload.customer?.id;
  if (!id) return new Response();

  const errors = await forgetCustomer(admin, `gid://shopify/Customer/${id}`);
  // A 200 confirms receipt, and that's all a compliance webhook owes. The 30 days to
  // finish belong to the app, and a real app would queue this retry.
  if (errors.length) {
    console.error(errors.map((error) => error.message).join('. '));
  }

  return new Response();
};

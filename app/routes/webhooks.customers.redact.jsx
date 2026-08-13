import {authenticate} from '../shopify.server';
import {forgetCustomer} from '../campaigns.server';

// Launching a campaign saves the tier roster onto the record: a customer ID and a
// display name per member. Redaction has to reach that too. `authenticate.webhook`
// answers an invalid HMAC with a 401 before any of this runs.
export const action = async ({request}) => {
  const {admin, shop, topic, payload} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  // Without a session there's no installation, and the record went with it.
  if (!admin) return new Response();

  const id = payload.customer?.id;
  if (!id) return new Response();

  const errors = await forgetCustomer(admin, `gid://shopify/Customer/${id}`);
  // A 200 confirms receipt, which is what's required of every compliance webhook.
  // The 30 days to finish are the app's own. A real app queues this retry rather
  // than waiting for a redelivery that isn't coming.
  if (errors.length) {
    console.error(errors.map((error) => error.message).join('. '));
  }

  return new Response();
};

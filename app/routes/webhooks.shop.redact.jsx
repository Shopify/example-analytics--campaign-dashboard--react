import {authenticate} from '../shopify.server';
import {forgetShop} from '../campaign-state.server';

// 48 hours after an uninstall. The campaign entries belong to the store and stay in
// the admin. The app deletes its sessions, campaign records, locks, and spent IDs.
export const action = async ({request}) => {
  const {shop, topic} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  await forgetShop(shop);

  return new Response();
};

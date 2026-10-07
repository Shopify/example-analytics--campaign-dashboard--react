import {authenticate} from '../shopify.server';
import db from '../db.server';

// 48 hours after an uninstall. The campaign entries belong to the store and stay in
// the admin. The app holds only the session rows, and it can't reach the store anymore.
export const action = async ({request}) => {
  const {shop, topic} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  await db.session.deleteMany({where: {shop}});

  return new Response();
};

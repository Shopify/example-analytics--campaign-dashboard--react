import {authenticate} from '../shopify.server';
import db from '../db.server';

// 48 hours after an uninstall. Every campaign record lived in a metafield on the
// installation and went with it, which leaves the session rows this app wrote.
export const action = async ({request}) => {
  const {shop, topic} = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  await db.session.deleteMany({where: {shop}});

  return new Response();
};

import {authenticate} from '../shopify.server';
import db from '../db.server';

export const action = async ({request}) => {
  const {shop, session, topic} = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // A webhook can fire more than once, including after the uninstall. An earlier run
  // may have deleted the session already.
  if (session) {
    await db.session.deleteMany({where: {shop}});
  }

  return new Response();
};

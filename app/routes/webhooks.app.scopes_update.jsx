import {authenticate} from '../shopify.server';
import db from '../db.server';

export const action = async ({request}) => {
  const {payload, session, topic, shop} = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.update({
      where: {id: session.id},
      data: {scope: payload.current.toString()},
    });
  }

  return new Response();
};

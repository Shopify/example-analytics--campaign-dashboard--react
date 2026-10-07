import {redirect} from 'react-router';

import {login} from '../shopify.server';

// `login` throws a redirect into the install flow. A return means an invalid domain, sent
// back as `shop_error` because a `shop` parameter starts an install.
export const action = async ({request}) => {
  const {shop} = await login(request);

  return redirect(`/?shop_error=${shop ?? 'MISSING_SHOP'}`);
};

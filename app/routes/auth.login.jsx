import {redirect} from 'react-router';

import {login} from '../shopify.server';

// The landing page's form posts here. `login` sanitizes the domain and throws a redirect
// into the install flow. Reaching the return means the domain was invalid, and it goes
// back under its own name, because a `shop` parameter starts an install.
export const action = async ({request}) => {
  const {shop} = await login(request);

  return redirect(`/?shop_error=${shop ?? 'MISSING_SHOP'}`);
};

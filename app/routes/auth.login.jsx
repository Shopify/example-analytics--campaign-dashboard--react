import {redirect} from 'react-router';

import {login} from '../shopify.server';

// The landing page's form posts here. `login` sanitizes the domain and throws a redirect
// into the install flow. Reaching the return means the domain couldn't be one, which the
// landing page reports. Sent back under its own name: a `shop` parameter on the landing
// page means an install, not a rejection. This route is more specific than `auth.$`,
// which takes the OAuth callback.
export const action = async ({request}) => {
  const {shop} = await login(request);

  return redirect(`/?shop_error=${shop ?? 'MISSING_SHOP'}`);
};

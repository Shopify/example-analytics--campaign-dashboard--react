import {boundary} from '@shopify/shopify-app-react-router/server';
import {authenticate} from '../shopify.server';

// Authenticate before redirecting, or an embedded load skips token exchange.
export async function loader({request}) {
  const {redirect} = await authenticate.admin(request);
  // This redirect carries the request's search params, which hold App Bridge's shop and host.
  return redirect('/app/campaigns');
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

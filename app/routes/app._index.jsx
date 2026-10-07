import {redirect} from 'react-router';
import {authenticate} from '../shopify.server';

// Authenticate before redirecting, or an embedded load skips token exchange.
export async function loader({request}) {
  await authenticate.admin(request);
  // App Bridge reads shop and host off the page URL. A redirect can't drop them.
  const {search} = new URL(request.url);
  return redirect(`/app/campaigns${search}`);
}

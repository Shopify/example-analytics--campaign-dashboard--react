import {redirect} from 'react-router';
import {authenticate} from '../shopify.server';

// The app opens on the campaign list. Authenticate before redirecting so an
// embedded load still goes through token exchange rather than arriving at the next
// route unauthenticated.
export async function loader({request}) {
  await authenticate.admin(request);
  // Carry the search params across: App Bridge reads shop and host off the
  // page URL, and a redirect that drops them leaves it unable to initialize.
  const {search} = new URL(request.url);
  return redirect(`/app/campaigns${search}`);
}

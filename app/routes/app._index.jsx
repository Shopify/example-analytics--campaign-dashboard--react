import {redirect} from 'react-router';
import {authenticate} from '../shopify.server';

// The app opens on the campaign list. Authenticate before redirecting so an
// embedded load still goes through token exchange rather than arriving at the next
// route unauthenticated.
export async function loader({request}) {
  await authenticate.admin(request);
  return redirect('/app/campaigns');
}

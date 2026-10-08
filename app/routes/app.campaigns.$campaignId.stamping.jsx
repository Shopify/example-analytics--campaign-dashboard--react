import {authenticate} from '../shopify.server';
import {readBulkOperation} from '../bulk-stamp.server';
import {readState} from '../campaign-state.server';
import {withReturnedErrors} from '../campaigns.server';

// [START campaign-dashboard.stamp-status-route]
// The page polls this route while stamping runs. It reads one bulk operation and none of
// the page's reports, which keeps the poll off the store's ShopifyQL limit.
export async function loader({request, params}) {
  const {admin, session} = await authenticate.admin(request);
  const state = await readState(session.shop, params.campaignId);
  if (!state?.stampOperation) return {state: 'done', objectCount: 0, problems: []};
  return readBulkOperation(withReturnedErrors(admin), state.stampOperation);
}
// [END campaign-dashboard.stamp-status-route]

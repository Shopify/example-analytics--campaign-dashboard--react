import {Outlet, useLoaderData, useRouteError} from 'react-router';
import {boundary} from '@shopify/shopify-app-react-router/server';
import {AppProvider} from '@shopify/shopify-app-react-router/react';

import {authenticate} from '../shopify.server';

export const loader = async ({request}) => {
  await authenticate.admin(request);

  return {apiKey: process.env.SHOPIFY_API_KEY || ''};
};

export default function App() {
  const {apiKey} = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* [START campaign-dashboard.analytics-script] */}
      {/* AppProvider already injects app-bridge.js and polaris.js. The analytics
          UI script is what registers s-metrics-bar and s-shopifyql-metric-card,
          and it isn't included. */}
      <script src="https://cdn.shopify.com/shopifycloud/analytics-ui.js" />
      {/* [END campaign-dashboard.analytics-script] */}
      <s-app-nav>
        <s-link href="/app/campaigns">Campaigns</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their
// headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

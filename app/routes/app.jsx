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
      {/* AppProvider leaves out the analytics UI script. It registers s-metrics-bar
          and s-shopifyql-metric-card. */}
      <script src="https://cdn.shopify.com/shopifycloud/analytics-ui.js" />
      {/* [END campaign-dashboard.analytics-script] */}
      {/* [START campaign-dashboard.app-nav] */}
      <s-app-nav>
        <s-link href="/app/campaigns">Campaigns</s-link>
        <s-link href="/app/qrcodes">QR codes</s-link>
      </s-app-nav>
      {/* [END campaign-dashboard.app-nav] */}
      <Outlet />
    </AppProvider>
  );
}

// React Router has to catch some thrown Shopify responses to keep their headers.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

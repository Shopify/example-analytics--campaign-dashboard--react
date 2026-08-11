# Campaign performance dashboard

An embedded Shopify app that answers whether a marketing campaign worked, then writes the answer back onto the store's own analytics. It reports its own funnel with [App Events](https://shopify.dev/docs/apps/build/app-events/analytics), queries that funnel and the store's sales with [ShopifyQL](https://shopify.dev/docs/api/shopifyql), and records the outcome as [annotations](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsAnnotationCreate) and [targets](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsTargetCreate) on the store's analytics timeline.

Companion code for [Build a campaign performance dashboard](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard), which explains why each piece is built this way. This README gets it running.

## Requirements

- A [Shopify Partner account](https://www.shopify.com/partners) and a development store.
- Node.js 20.19 or later, or 22.12 or later.
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli), installed globally. It isn't a dependency of this app, and the `npm run` scripts below all shell out to it:

  ```shell
  npm install -g @shopify/cli@latest
  ```

- [Level 2 access to protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data), which `shopifyqlQuery` requires. Approval can take time, so request it early.
- API version `2026-10` or later. Annotations and targets aren't available before it.
- [App Events in Analytics](https://shopify.dev/docs/apps/build/app-events/analytics) access. The preview is available to approved apps, and [early access is open](https://forms.gle/2yLka2Ww3J3cNiGY8).

  **Without App Events access, the app still runs and nothing fails.** Sales, goals, timeline, and insight all work, and the campaign still writes its annotations and targets. The Funnel and Sequence panels are the two that need the dataset. They report that they can't reach it and stay empty, and **Send the campaign's events** has nothing to query back.

## Run it

1. Clone the repository and install dependencies:

   ```shell
   git clone https://github.com/shopify-playground/example-analytics--campaign-dashboard--react.git
   cd example-analytics--campaign-dashboard--react
   npm install
   ```

2. Connect the app to your Partner account and choose a development store:

   ```shell
   npm run config:link
   ```

3. Create the local SQLite database that holds OAuth sessions:

   ```shell
   npm run setup
   ```

4. Release the configuration, so the access scopes, the webhook subscription, and the App Events declarations reach Shopify:

   ```shell
   npm run deploy
   ```

5. Start the app, then install it on your development store when the CLI prompts you:

   ```shell
   npm run dev
   ```

Open the app from the store's admin. It opens on the campaign list.

Wait a few minutes after step 4 before you report any events. A released configuration takes time to reach the store, and an event that arrives before its declaration is live is marked ineligible for analytics on arrival. That verdict is never revisited.

Shopify CLI doesn't report the `analytics_app_events` extension on startup, so the Funnel panel is the signal that the declaration landed. While it reports that it can't reach the dataset, don't send. That message covers both a declaration that hasn't propagated yet and an org without App Events access, so if it doesn't clear after a few minutes, confirm your access before assuming it's propagation.

This repository ships no credentials. `client_id` in `shopify.app.toml` is empty, and `.env` and `.env.*` are in `.gitignore`. Step 2 writes your own `client_id`, `application_url`, and `redirect_urls` into `shopify.app.toml`, and `shopify app dev` provides your `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` to the running process. Never put a client secret in `shopify.app.toml`, which is a tracked file.

## Use the dashboard

The first load seeds one planned campaign called `Summer launch` over the last two weeks, so the queries return whatever your development store has actually sold. Open it from the list.

A planned campaign hasn't written anything to the store yet, so set it up first:

1. Click **Select products** and choose up to five.
2. Choose an **Audience** tier.
3. Under **Dimensions this app owns**, click **Create it as a dimension** on each row.

Then click **Launch the campaign**, followed by **Send the campaign's events**. The replay is around 680 events and runs for a minute or two, and the funnel panels stay empty for a few minutes after it finishes while Shopify ingests them.

## What each panel shows

| Panel | What it shows |
|-------|---------------|
| Sales | Revenue and orders over the campaign's window, with [metric cards](https://shopify.dev/docs/api/shopifyql/2026-10/web-components/metric-card) on a shared date picker. |
| Goals | Progress against up to three targets, one store-wide, one for the promoted products, and one for the targeted audience. |
| Funnel | One chart for each channel, from `FROM app_events`. |
| Sequence | Each of the nine touches on its own. |
| Timeline | The store's annotations for the campaign's weeks, the app's own markers alongside anyone else's. |
| Insight | The longest unbroken run up or down in each product's weekly sales. |

## How it's built

This is the [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router) in JavaScript, with two routes added:

| Path | File | What it holds |
|------|------|---------------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` | The campaign list, and the form that creates one. |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` | The dashboard, and every action that writes to the store. |

Every GraphQL document is in `app/campaign-queries.server.js`. Campaign records live in `app/campaigns.server.js`, and the App Events client and the send plan in `app/app-events.server.js`. The event declarations are in `extensions/app-events/shopify.extension.toml`, not in `shopify.app.toml`. The rest of `app/` is the campaign model the two routes share.

A campaign is a record in one app-data metafield rather than a row in a table, so there's no schema to design and no migration to run. A real app would use its own storage, and `CAMPAIGN_FIELDS` documents the shape field by field.

App Events data can't be deleted, and a reused idempotency key is dropped along with its payload. After you change an event payload, bump the `RUN` constant in `app/app-events.server.js` so the replay gets a fresh set of keys.

For a smaller starting point that covers the ShopifyQL half on its own, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and its companion repository, [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on the [tutorial page](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

## License

This sample is released under the [MIT License](./LICENSE.md).

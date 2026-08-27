# Campaign performance dashboard

An embedded Shopify app that reports whether a marketing campaign worked, then writes the answer back onto the store's analytics.

It reports its marketing funnel with [App Events](https://shopify.dev/docs/apps/build/app-events/analytics), queries that funnel and the store's sales with [ShopifyQL](https://shopify.dev/docs/api/shopifyql), and records the outcome as annotations and targets on the store's analytics timeline.

This repository is the finished app. A three-part tutorial series builds it, one capability per part.

1. [Configure an app and query a campaign's sales](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-sales) queries a campaign's sales and your app's dimensions with ShopifyQL.
2. [Set campaign targets and annotations](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-targets-and-annotations) sets a revenue target and marks the campaign on the store's analytics timeline.
3. [Report on a campaign with App Events](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-app-events) reports your app's marketing events, then queries the funnel beside the sales.

## Setup

You'll need Node 20.19+ or 22.12+, [app development permissions](https://shopify.dev/docs/apps/build/dev-dashboard/user-permissions), a [dev store](https://shopify.dev/docs/apps/build/dev-dashboard/development-stores), and the latest [Shopify CLI](https://shopify.dev/docs/api/shopify-cli).

1. Install Shopify CLI:

   ```shell
   npm install -g @shopify/cli@latest
   ```

2. Clone the repository and install its dependencies:

   ```shell
   git clone https://github.com/shopify-playground/example-analytics--campaign-dashboard--react.git
   cd example-analytics--campaign-dashboard--react
   npm install
   ```

3. Create the app record and link this directory to it:

   ```shell
   npm run config:link
   ```

4. Restore `access_scopes.scopes` in `shopify.app.toml`. `config:link` overwrites the line with whatever the app record holds, and a new record holds nothing. An app installed with no scopes fails every query and every write:

   ```toml
   [access_scopes]
   scopes = "read_reports,write_reports,read_analytics_annotations,write_analytics_annotations,write_products,write_customers,write_orders"
   ```

5. Create the local database, then deploy the app and its event declarations:

   ```shell
   npm run setup
   npm run deploy
   ```

6. Start the app, press `p` to open the preview URL, then click **Install app**. The prompt lists the scopes from step 4:

   ```shell
   npm run dev
   ```

The app opens on a campaign list holding two seeded campaigns. Every panel reads `$0` or has no rows until you request the two kinds of access below and the store has orders to report. The event declaration from `npm run deploy` also takes a few minutes to propagate before any App Events query returns rows.

## Access to request

| Access | What stays empty without it |
|--------|-----------------------------|
| [Level 2 protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) | The campaign detail page. `shopifyqlQuery` returns an access error, the loader throws, and the route's error boundary replaces the page. The campaign list still loads. |
| [App Events in Analytics](https://shopify.dev/docs/apps/build/app-events/analytics) | **Campaign events**, **Channel metrics**, **Send performance**, and **Deliverability**. |

### Level 2 protected customer data

`shopifyqlQuery` requires Level 2 across all four protected fields, and the error names them: `Level 2 access to Customer data including name, address, phone, and email fields`. Request only **Name** and every sales panel stays empty.

On a dev store the request is self-serve, with no review to wait on:

1. Open the app that `config:link` created in the [Partner Dashboard](https://partners.shopify.com), then go to **API access requests**.
2. Under **Protected customer data access**, click **Manage**.
3. Click **Select** on **Protected customer data**, choose your reasons, then click **Save**.
4. Repeat step 3 for **Name**, **Email**, **Phone**, and **Address**.

Saving each request grants the access.

Leave this app's distribution method unset. [Requesting protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data#request-access-to-protected-customer-data) needs no distribution method, and picking **Custom distribution** removes the request flow for good.

### App Events in Analytics

An early-access program. [Request access with this form](https://forms.gle/2yLka2Ww3J3cNiGY8) and wait for a reply. There's no self-serve path.

`shopify.app.toml` pins `api_version = "2026-10"`, the first version with annotations and targets. Don't lower it.

## Credentials

This repository ships none. `client_id` is empty in `shopify.app.toml`, and `.env` and `.env.*` are gitignored. `config:link` writes your own `client_id`, `application_url`, and `redirect_urls`, and `shopify app dev` supplies `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` to the running process.

Never put a client secret in `shopify.app.toml`. It's a tracked file.

## Use the dashboard

The first load seeds two campaigns, both planned, dated relative to your install:

| Campaign | Window | What it shows |
|----------|--------|---------------|
| `Summer launch` | Opened 20 days ago, a week left | Nine sends dated between 20 and 7 days ago. Step 4 posts them. |
| `Back to school` | Starts in two weeks | Nothing to report. Every panel shows the setup it still needs. |

1. On the campaign list, under **Dimensions this app owns**, click **Create it as a dimension** on each of the three rows. Do this once. A report that groups on a dimension returns no rows until the dimension is queryable.
2. Open `Summer launch`. Under **Campaign setup**, click **Select products** and choose up to five, then choose a **Customer segment**.
3. Click **Launch the campaign**. Annotations and targets appear on the next render.
4. Click **Send the campaign's events**. The button names the event count. Posting them takes a minute or two, and the funnel panels have numbers a few minutes after that.
5. Click **Open this report in the store's analytics dashboard** to confirm the annotations landed outside the app.

Three more controls write to those same charts. **Close the campaign with its result** rewrites the annotation with what the campaign earned and stamps each order with the send it followed. **Cancel the campaign** takes the annotations and targets back off the store. **Plan the campaign again** returns it to planned for a second launch.

Campaign records live in an app-data metafield on the store's app installation. The local database holds sessions. Re-cloning doesn't reset them. The seed only runs against an empty metafield, and a fresh app installation gives you one.

## Get numbers on the charts

A dev store with no orders reports `$0`. The seed creates campaigns. The sales those campaigns are supposed to have moved come from orders you place.

- Place test orders inside `Summer launch`'s window. Its nine sends land between 20 and 7 days before you install.
- Cluster the orders in the days right after a send, with the largest cluster in the last few days. Orders placed only in the opening week make every follow-up read as having moved nothing.
- Create `AVERY10`, `AVERYSUMMER`, and `JUNO15` under **Discounts**, then place storefront orders that use them. **Creator revenue** groups sales by `discount_code`. That column counts a code only when a buyer enters it at checkout. A discount added to an order in the admin has no code. The panel stays hidden until one order has one.

## What it does

A launched campaign opens on what it promised, then states what that added up to. The panels below it follow the order in which a campaign produces its evidence. Targets come first, then sales against the period before, the send funnel per channel, revenue grouped by the dimensions this app creates, and a closing summary written back to the store's timeline.

Each panel shows chips beside its title naming what produced the number, whether that's ShopifyQL, App Events, metafields, annotations, or web components.

The [tutorial series](https://shopify.dev/docs/apps/build/analytics) walks through every panel and the queries behind it.

## Troubleshooting

| What you see | What it means |
|--------------|---------------|
| Every sales panel is empty, and the server log reports an access error on `shopifyqlQuery` | Either the `scopes` line didn't survive `config:link`, or Level 2 access hasn't landed for this app. Reading live analytics needs both `read_reports` and Level 2. |
| Every sales panel reads `$0` | The store has no orders in the campaign's window. |
| `This store can't query App Events yet` | Either `npm run deploy` hasn't propagated, or the organization doesn't have App Events access. |
| `Column Not Found` on an `app_events` query | The declaration hasn't reached the store. Don't send events until it clears. |
| **Creator revenue** doesn't appear | No sale has one of the three codes. A discount added to an order in the admin doesn't count, because analytics reads the code off the discount itself and a manual discount has none. |
| **Promoted product sales** or a segment panel is empty | The dimension isn't queryable yet. Create it from **Dimensions this app owns**. |
| **Order attribution** is missing after a close | Analytics takes a few minutes to index the order metafields the close wrote. Reload the page then. |
| A campaign shows a status you didn't set | Records live on the store. The clone holds none of them. |
| An event replay posts but nothing changes | A reused idempotency key is dropped with its payload. Bump the `RUN` constant in `app/app-events.server.js`. No query filters on `RUN`. A replay adds to the events already recorded under that `campaign_id`. Create a new campaign for a clean set of numbers. |

## How it's built

The [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router), converted to JavaScript, with two routes added:

| Path | File |
|------|------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` |

GraphQL documents are in `app/campaign-queries.server.js`, campaign records in `app/campaigns.server.js`, and the App Events client and send plan in `app/app-events.server.js`. Each group of panels is a separate module under `app/panels/`. Event declarations are in `extensions/app-events/shopify.extension.toml`. `shopify.app.toml` holds none of them.

One app-data metafield holds every campaign record. A real app would use a database. `CAMPAIGN_FIELDS` documents the shape field by field.

For a smaller starting point covering only the ShopifyQL half, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on any [tutorial page](https://shopify.dev/docs/apps/build/analytics).

## License

Released under the [MIT License](./LICENSE.md).

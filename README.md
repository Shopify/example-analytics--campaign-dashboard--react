# Campaign performance dashboard

An embedded Shopify app that reports whether a marketing campaign worked, then writes the answer back onto the store's own analytics.

It reports its own funnel with [App Events](https://shopify.dev/docs/apps/build/app-events/analytics), queries that funnel and the store's sales with [ShopifyQL](https://shopify.dev/docs/api/shopifyql), and records the outcome as annotations and targets on the store's analytics timeline.

This repository is the finished app, and two tutorials build it. [Build a campaign performance dashboard](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard) covers the whole app in one pass. The four-part series covers one capability per part, for adding a single capability to an app you already have.

1. [Store a campaign and report its sales](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-sales) stores a campaign and reports its sales with ShopifyQL.
2. [Set campaign targets and annotate the timeline](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-targets-and-annotations) adds revenue targets and annotations on the store's own charts.
3. [Report a campaign funnel with App Events](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-app-events) adds the email, SMS, and push funnel.
4. [Group campaign sales by your app's metafields](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-dimensions) turns app-owned metafields into ShopifyQL dimensions and closes the campaign.

## Setup

You'll need Node 20.19+ or 22.12+, [app development permissions](https://shopify.dev/docs/apps/build/dev-dashboard/user-permissions), a [dev store](https://shopify.dev/docs/apps/build/dev-dashboard/development-stores), and the latest [Shopify CLI](https://shopify.dev/docs/api/shopify-cli).

1. Install Shopify CLI:

   ```shell
   npm install -g @shopify/cli@latest
   ```

2. Clone the repository and install its dependencies:

   ```shell
   git clone https://github.com/Shopify/example-analytics--campaign-dashboard--react.git
   cd example-analytics--campaign-dashboard--react
   npm install
   ```

3. Create the app record and link this directory to it:

   ```shell
   npm run config:link
   ```

4. Restore `access_scopes.scopes` in `shopify.app.toml`. `config:link` empties it, and an app installed with no scopes fails every query and every write:

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
| [Level 2 protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) | Every panel that reads sales. `shopifyqlQuery` returns no data. |
| [App Events in Analytics](https://shopify.dev/docs/apps/build/app-events/analytics) | **Campaign events**, **Channel metrics**, **Send performance**, and **Deliverability**. |

### Level 2 protected customer data

This app needs Level 2 because the audience roster reads `Customer.displayName`, a protected name field. On a dev store it's self-serve, with no review to wait on:

1. Open the app that `config:link` created in the [Dev Dashboard](https://dev.shopify.com/dashboard). Shopify CLI creates its app records there.
2. [Select a distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method) and pick **Custom distribution**. You can't request customer data access without one, and you can't change the choice afterward. Custom distribution needs no approval and covers your dev store.
3. [Request access to protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data#request-access-to-protected-customer-data) and select the **Name** field, the only protected field this app reads.

Saving the request grants the access.

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
| `Summer launch` | Opened 20 days ago, a week left | Nine sends finished a week ago, leaving room for the sales they moved. |
| `Back to school` | Starts in two weeks | Nothing to report. Every panel shows the setup it still needs. |

1. On the campaign list, under **Dimensions this app owns**, click **Create it as a dimension** on each of the three rows. Do this once. A report that groups on a dimension returns no rows until the dimension is queryable.
2. Open `Summer launch`. Under **Campaign setup**, click **Select products** and choose up to five, then choose a **Customer segment**.
3. Click **Launch the campaign**. Annotations and targets appear on the next render.
4. Click **Send the campaign's events**. The button names the event count. Posting them takes a minute or two, and the funnel panels have numbers a few minutes after that.
5. Click **Open this report in the store's analytics dashboard** to confirm the annotations landed outside the app.

Three more controls write to those same charts. **Close the campaign with its result** rewrites the annotation with what the campaign earned and stamps each order with the send it followed. **Cancel the campaign** takes the annotations and targets back off the store. **Plan the campaign again** returns it to planned for a second launch.

Campaign records live in an app-data metafield on the store's app installation, not in the local database. Re-cloning doesn't reset them. The seed only runs against an empty metafield, and a fresh app installation gives you one.

## Get numbers on the charts

A dev store with no orders reports `$0`. The seed creates campaigns, not the sales those campaigns are supposed to have moved.

- Place test orders inside `Summer launch`'s window. Its nine sends land between 20 and 7 days before you install.
- Cluster the orders in the days right after a send rather than spreading them evenly, and put the largest cluster in the last few days. Orders placed only in the opening week make every follow-up read as having moved nothing.
- Create `AVERY10`, `AVERYSUMMER`, and `JUNO15` under **Discounts**, then place storefront orders that use them. **Creator revenue** groups sales by `discount_code`, which counts a code only when a buyer enters it at checkout. A discount added to an order in the admin carries no code. The panel stays hidden until one order carries one.

## What it does

A launched campaign opens on what it promised, then states what that added up to. The panels below it follow the order in which a campaign produces its evidence. Targets come first, then sales against the period before, the send funnel per channel, revenue grouped by the dimensions this app creates, and a closing summary written back to the store's timeline.

Each panel carries chips beside its title naming what produced the number, whether that's ShopifyQL, App Events, metafields, annotations, or web components.

The [tutorial](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard) walks through every panel and the queries behind it.

## Troubleshooting

| What you see | What it means |
|--------------|---------------|
| Every sales panel is empty, and the server log reports an access error on `shopifyqlQuery` | Either the `scopes` line didn't survive `config:link`, or Level 2 access hasn't landed for this app. Reading live analytics needs both `read_reports` and Level 2. |
| Every sales panel reads `$0` | The store has no orders in the campaign's window. |
| `This store can't query App Events yet` | Either `npm run deploy` hasn't propagated, or the organization doesn't have App Events access. |
| `Column Not Found` on an `app_events` query | The declaration hasn't reached the store. Don't send events until it clears. |
| **Creator revenue** doesn't appear | No sale carries one of the three codes. A discount added to an order in the admin doesn't count, because analytics reads the code off the discount itself and a manual discount has none. |
| **Promoted product sales** or a segment panel is empty | The dimension isn't queryable yet. Create it from **Dimensions this app owns**. |
| A campaign shows a status you didn't set | Records live on the store, not in the clone. |
| An event replay posts but nothing changes | A reused idempotency key is dropped with its payload. Bump the `RUN` constant in `app/app-events.server.js`. No query filters on `RUN`. A replay adds to the events already recorded under that `campaign_id`. Create a new campaign for a clean set of numbers. |

## How it's built

The [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router), converted to JavaScript, with two routes added:

| Path | File |
|------|------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` |

GraphQL documents are in `app/campaign-queries.server.js`, campaign records in `app/campaigns.server.js`, and the App Events client and send plan in `app/app-events.server.js`. Each group of panels is its own module under `app/panels/`. Event declarations are in `extensions/app-events/shopify.extension.toml`, not in `shopify.app.toml`.

A campaign is a record in one app-data metafield rather than a row in a table. A real app would use its own storage. `CAMPAIGN_FIELDS` documents the shape field by field.

For a smaller starting point covering the ShopifyQL half on its own, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on any [tutorial page](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

## License

Released under the [MIT License](./LICENSE.md).

# Campaign performance dashboard

An embedded Shopify app that reports whether a marketing campaign worked, then writes the answer back onto the store's own analytics.

It reports its own funnel with [App Events](https://shopify.dev/docs/apps/build/app-events/analytics), queries that funnel and the store's sales with [ShopifyQL](https://shopify.dev/docs/api/shopifyql), and records the outcome as annotations and targets on the store's analytics timeline.

Companion code for [Build a campaign performance dashboard](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

## Quickstart

You'll need Node 20.19+ or 22.12+, a [Shopify Partner account](https://www.shopify.com/partners), a development store, and [Shopify CLI](https://shopify.dev/docs/api/shopify-cli):

```shell
npm install -g @shopify/cli@latest
```

Clone and link:

```shell
git clone https://github.com/Shopify/example-analytics--campaign-dashboard--react.git
cd example-analytics--campaign-dashboard--react
npm install
npm run config:link
```

`config:link` empties `access_scopes.scopes`. Restore it in `shopify.app.toml` before you deploy, because an app installed with no scopes fails every query and every write:

```toml
[access_scopes]
scopes = "read_reports,write_reports,read_analytics_annotations,write_analytics_annotations,write_products,write_customers,write_orders"
```

Now request [the access the panels need](#access-to-request). Both requests are against the app that `config:link` created, and every sales panel stays empty until the first one lands.

Then:

```shell
npm run setup
npm run deploy
npm run dev
```

Press `p` to open the preview URL, then click **Install app**. The install prompt lists the scopes above. The app opens on the campaign list.

Don't send events for a few minutes after `npm run deploy`. An event is [eligible for analytics](https://shopify.dev/docs/apps/build/app-events/analytics#how-analytics-eligibility-works) only if it matches an accepted declaration, and a reused idempotency key is dropped. Events sent too early can't be resent under the same keys. The **Channel metrics** panel reaching its dataset is the signal that the declaration landed.

## Access to request

Neither gates whether the app runs. Both gate what the panels show.

| Access | What stays empty without it |
|--------|-----------------------------|
| [Level 2 protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) | Every panel that reads sales. `shopifyqlQuery` returns no data. |
| [App Events in Analytics](https://shopify.dev/docs/apps/build/app-events/analytics) | **Campaign events**, **Channel metrics**, **Send performance**, and **Deliverability**. |

### Level 2 protected customer data

This app needs Level 2 because the audience roster reads `Customer.displayName`, a protected name field. On a development store it's self-serve, with no review to wait on:

1. [Select a distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method) for the app. You can't request customer data access without one, and a freshly linked app doesn't have one. Pick **Custom distribution**. It needs no approval, it covers your own development store, and its only limitation is the Billing API, which this app doesn't use. You can't change the choice afterward.
2. In the [Partner Dashboard](https://partners.shopify.com/current/apps), open the app that `config:link` created.
3. Click **API access requests**, find **Protected customer data access**, and click **Request access**.
4. Select **Protected customer data**, give your reasons for using it, and click **Save**.
5. Select the **Name** field, give your reasons for using it, and click **Save**.

You have access after step 5. An app installed only on a development store doesn't get submitted for review.

### App Events in Analytics

An early-access program. [Request access with this form](https://forms.gle/2yLka2Ww3J3cNiGY8) and wait for a reply. There's no self-serve path.

You also need API version `2026-10` or later. Annotations and targets don't exist before it.

## Credentials

This repository ships none. `client_id` is empty in `shopify.app.toml`, and `.env` and `.env.*` are gitignored. `config:link` writes your own `client_id`, `application_url`, and `redirect_urls`, and `shopify app dev` supplies `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` to the running process.

Never put a client secret in `shopify.app.toml`. It's a tracked file.

## Use the dashboard

The first load seeds two campaigns, both planned, dated relative to your install:

| Campaign | Window | What it shows |
|----------|--------|---------------|
| `Summer launch` | Opened 20 days ago, a week left | Nine sends finished a week ago, leaving room for the sales they moved. |
| `Back to school` | Starts in two weeks | Nothing to report. Every panel is the setup it still needs. |

1. On the campaign list, under **Dimensions this app owns**, click **Create it as a dimension** on each of the three rows. This is a one-time step, and reports that group on a dimension have nothing to draw until it's queryable.
2. Open `Summer launch`. Under **Campaign setup**, click **Select products** and choose up to five, then choose a **Customer segment**.
3. Click **Launch the campaign**. Markers and targets appear on the next render.
4. Click **Send the campaign's events**. The button names the event count. The replay takes a minute or two to post, and the funnel panels fill a few minutes later.
5. Click **Open this report in the store's analytics dashboard** to confirm the markers landed outside the app.

Then run the remaining writes and watch each one reach those same charts. **Close the campaign with its result** rewrites the marker with what the campaign earned and stamps each order with the send it followed. **Cancel the campaign** takes the markers and targets back off the store. **Plan the campaign again** returns it to planned so you can launch it a second time.

Campaign records live in an app-data metafield on the store's app installation, not in the local database. Re-cloning doesn't reset them. The seed only runs against an empty metafield, and a fresh app installation is what gives you one.

## Getting numbers on the charts

A development store with no orders reports `$0` everywhere. That's the app working, not a broken install.

- Place test orders inside `Summer launch`'s window. Its nine sends land between 20 and 7 days before you install.
- Cluster the orders in the days right after a send rather than spreading them evenly, and put the largest cluster in the last few days. Orders placed only in the opening week make every follow-up read as having moved nothing.
- For **Creator revenue**, create `AVERY10`, `AVERYSUMMER`, and `JUNO15` under **Discounts** in the admin first, then redeem one on each order.

## What it does

A launched campaign opens on what it promised, states what that added up to, then shows the evidence in the order a campaign produces it. Targets, sales against the period before, the send funnel per channel, revenue grouped by the dimensions this app creates, and a closing summary written back to the store's timeline.

Each panel carries chips beside its title naming what produced the number, whether that's ShopifyQL, App Events, metafields, annotations, or web components.

The [tutorial](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard) walks through every panel and the queries behind it.

## Troubleshooting

| What you see | What it means |
|--------------|---------------|
| Every sales panel is empty, and the server log reports an access error on `shopifyqlQuery` | Either the `scopes` line didn't survive `config:link`, or Level 2 access hasn't landed for this app. Reading live analytics needs both `read_reports` and Level 2. |
| Every sales panel reads `$0` | The store has no orders in the campaign's window. |
| `This store can't query App Events yet` | Either `npm run deploy` hasn't propagated, or the organization doesn't have App Events access. |
| `Column Not Found` on an `app_events` query | The declaration hasn't reached the store. Don't send events until it clears. |
| **Creator revenue** reads `$0` with orders on the chart | The three discount codes don't exist, or no order redeemed one. |
| **Promoted product sales** or a segment panel is empty | The dimension isn't queryable yet. Create it from **Dimensions this app owns**. |
| A campaign shows a status you didn't set | Records live on the store, not in the clone. |
| An event replay posts but nothing changes | A reused idempotency key is dropped with its payload. Bump the `RUN` constant in `app/app-events.server.js`. No query filters on `RUN`. A replay adds to the events already recorded under that `campaign_id`. Create a new campaign for a clean set of numbers. |

## How it's built

The [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router) in JavaScript, with two routes added:

| Path | File |
|------|------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` |

GraphQL documents are in `app/campaign-queries.server.js`, campaign records in `app/campaigns.server.js`, and the App Events client and send plan in `app/app-events.server.js`. Event declarations are in `extensions/app-events/shopify.extension.toml`, not in `shopify.app.toml`.

A campaign is a record in one app-data metafield rather than a row in a table. A real app would use its own storage. `CAMPAIGN_FIELDS` documents the shape field by field.

For a smaller starting point covering the ShopifyQL half on its own, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on the [tutorial page](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

## License

Released under the [MIT License](./LICENSE.md).

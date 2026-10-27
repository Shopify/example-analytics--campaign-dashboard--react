# Campaign performance dashboard

An embedded Shopify app that measures a marketing campaign's sales and QR code traffic with ShopifyQL.

This branch holds the app as it stands at the end of part 1, [Query campaign sales](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-sales). It reads a campaign's sales with ShopifyQL and groups them by the dimensions the app creates. Targets and annotations arrive in part 2, and App Events in part 3. The finished app is on the [`main` branch](https://github.com/Shopify/example-analytics--campaign-dashboard--react).

## Setup

You'll need Node 22.12 or later, [app development permissions](https://shopify.dev/docs/apps/build/dev-dashboard/user-permissions), a [dev store](https://shopify.dev/docs/apps/build/stores/development-stores), and the latest [Shopify CLI](https://shopify.dev/docs/api/shopify-cli).

1. Install Shopify CLI:

   ```shell
   npm install -g @shopify/cli@latest
   ```

2. Clone the repository and install dependencies:

   ```shell
   git clone -b part-1 https://github.com/Shopify/example-analytics--campaign-dashboard--react.git
   cd example-analytics--campaign-dashboard--react
   npm ci
   ```

3. Create the app record and link this directory to it:

   ```shell
   npm run config:link
   ```

4. Restore `access_scopes.scopes` in `shopify.app.toml`. `config:link` overwrites the line, and a new app record has no scopes to write. If you install the app with no scopes, every query and every write fails:

   ```toml
   [access_scopes]
   scopes = "read_reports,read_analytics_annotations,write_products,write_customers,write_orders,write_metaobject_definitions,write_metaobjects,write_marketing_events"
   ```

5. Create the local database and start the app. Shopify CLI asks for a dev store and installs the app with the scopes from step 4. Press `p` to open the app:

   ```shell
   npm run setup
   npm run dev
   ```

6. In a second terminal, deploy the QR code metaobject definition. Run the deploy after `npm run dev` starts, because until then the app URL is a placeholder and the deploy rejects the webhook addresses:

   ```shell
   npm run deploy
   ```

The app opens on a campaign list with two campaigns that the app seeds. Panels read `$0` or show no rows until you request the access below and the store has orders.

## Tests

Run the unit tests, and check that every `[START]` tag the tutorials excerpt still has its `[END]` tag:

```shell
npm test
npm run check:markers
```

## Access to request

| Access | What stays empty without it |
|--------|-----------------------------|
| [Level 2 protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) | The campaign detail page. `shopifyqlQuery` returns an access error, and a **Couldn't load sales** banner replaces the panels. The campaign list still loads. |

### Level 2 protected customer data

`shopifyqlQuery` requires Level 2 across all four protected fields, and the error names them: `Level 2 access to Customer data including name, address, phone, and email fields`. Request only **Name** and every sales panel stays empty.

On a dev store the request is self-serve, with no review to wait on:

1. Open the app that `config:link` created in the [Partner Dashboard](https://partners.shopify.com), then go to **API access requests**.
2. Under **Protected customer data access**, click **Manage**.
3. Click **Select** on **Protected customer data**, choose your reasons, then click **Save**.
4. Repeat step 3 for **Name**, **Email**, **Phone**, and **Address**.

Saving each request grants the access.

Leave this app's distribution method unset. [Requesting protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data#request-access-to-protected-customer-data) needs no distribution method, and picking **Custom distribution** removes the request flow for good.

## API version

Two files pin version `2026-10`. `shopify.app.toml` sets `api_version` for webhooks, and `app/shopify.server.js` sets `apiVersion` for every GraphQL Admin API call. Keep both files on the same version.

## Credentials

This repository ships none. `client_id` is empty in `shopify.app.toml`, and `.gitignore` excludes `.env` files. `config:link` writes your own `client_id`, `application_url`, and `redirect_urls`, and `shopify app dev` supplies `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` to the running process.

Never put a client secret in `shopify.app.toml`. It's a tracked file.

## Use the dashboard

The first load seeds two planned campaigns. The app sets their dates relative to your install:

| Campaign | Window | What it shows |
|----------|--------|---------------|
| `Summer launch` | Opened 20 days ago, a week left | Its sales and orders against the period before. |
| `Back to school` | Starts in two weeks | Nothing to report. Every panel shows the setup it still needs. |

1. On the campaign list, under **Analytics dimensions**, click **Create dimension** on each of the three rows. Do this once. A report that groups on a dimension returns no rows until the dimension reads **Queryable**.
2. The product row now reads **Analytics off for Campaign**. Click **Turn on analytics** on that row. The admin opens the Campaign type. Turn on **Filter or group data in Analytics**, then reload the app. Only the merchant can change this setting. The row reads **Queryable** about 30 seconds later.
3. Open `Summer launch`. The page reports its sales and orders against the period before, plus **Top products**, **Creator revenue**, and **QR code sales**.

**Promoted product sales**, the segment panel, and **Order attribution** group on metafields that activation and close write. Part 2 adds activation and close. On this branch the three panels stay empty.

To try the QR code flow, click **QR codes** in the app's navigation and create a code. Under **Campaign**, pick a planned campaign, then save. A code belongs to one campaign, and the **Campaign** column on the list links to it. Every scan redirects to the product with the code's UTM parameters, and the **QR code sales** panel reports the sessions each code started and the orders shoppers place after scanning.

Each campaign is an entry of the **Campaign** metaobject type, which the app creates on first load. The admin lists the entries with the store's other metaobjects, and a merchant can edit them there. Re-cloning doesn't reset them. The seed runs once per store. Deleting the seeded campaigns doesn't bring them back. Each creator is an entry of the **Creator** type, and campaigns share those entries.

## Get numbers on the charts

A dev store with no orders reports `$0`. The seed creates campaigns. The sales come from orders you create.

- A dev store accepts only test payments, and test orders often don't reach the `sales` dataset. Create orders with the GraphQL Admin API's [`orderCreate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCreate) mutation instead, with a `processedAt` date inside `Summer launch`'s window, which opened 20 days before you install.
- **Creator revenue** groups sales by `discount_code`, and that column counts a code only when a buyer enters it at checkout. An order that you create through the API or in the admin has no code. **QR code sales** reads orders that follow a scan. Both panels need real checkouts on a store that accepts payments. On a dev store, **Creator revenue** lists each code at `$0` and **QR code sales** stays empty.

## What it does

A campaign's page reports its sales against the period before and the same days last year, its top products, then revenue grouped by the dimensions this app creates.

Chips beside each panel title name what produced the number, whether ShopifyQL, metafields, annotations, or web components.

The [tutorial series](https://shopify.dev/docs/apps/build/analytics) walks through every panel and the query behind it.

## Troubleshooting

| What you see | What it means |
|--------------|---------------|
| A **Couldn't load sales** banner replaces the sales panels | Either the `scopes` line didn't survive `config:link`, or Level 2 access hasn't landed for this app. Reading live analytics needs both `read_reports` and Level 2. |
| Every sales panel reads `$0` | The store has no orders in the campaign's window. |
| **Creator revenue** lists every code at `$0` | No sale has one of the three codes. A discount added in the admin has no code for analytics to group on. |
| **Promoted product sales** is empty | Nothing on this branch stamps products. On part 2 and `main`, analytics is off for the Campaign type, or the setting changed under a minute ago. Turn it on from the product row under **Analytics dimensions**. |
| A segment panel is empty | Nothing on this branch stamps customers. On part 2 and `main`, the dimension isn't queryable yet. Create it from **Analytics dimensions**. |
| A campaign shows a status you didn't set | Entries live on the store, and the admin can edit them. The clone holds none of them. |

## How it's built

The app starts from [Build a Shopify app using React Router](https://shopify.dev/docs/apps/build/build) and adds two campaign routes:

| Path | File |
|------|------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` |

The QR code routes come from that tutorial. `/app/qrcodes` lists the codes, `/app/qrcodes/:id` edits one, and the public `/qrcodes/:id` and `/qrcodes/:id/scan` routes serve the image and record each scan. `app/models/QRCode.server.js` holds their queries, and the codes live in an `$app:qrcode` metaobject that `shopify.app.toml` defines.

`app/campaign-queries.server.js` holds the GraphQL documents and `app/campaigns.server.js` reads and writes campaign entries. Each module under `app/panels/` renders one group of panels. `shopify.app.toml` holds no credentials.

Each campaign is an entry of the `campaign_dashboard_campaign` metaobject type. `ensureDefinition` creates the type at runtime, because analytics joins only types without the `$app:` prefix. Each QR code's `campaign` field holds its campaign entry's ID as text, because a field in `shopify.app.toml` can't reference a type the app creates at runtime. An uninstall leaves every campaign entry in place. `CAMPAIGN_FIELDS` documents the shape field by field.

The app keeps its private records in its own SQLite database through Prisma, and `app/campaign-state.server.js` reads and writes them. The records hold the IDs of the annotations and targets that each campaign created, how many events each campaign sent, the last campaign ID the app handed out, and a short-lived lock per campaign. The `shop/redact` webhook deletes them 48 hours after an uninstall.

Creators are entries of the `campaign_dashboard_creator` type, and `ensureDefinition` creates that type first. The Campaign `creators` field validates against the Creator definition's ID, and a metaobject reference validation can't change after the field exists. A runtime type keeps one ID for the life of the store, unless someone deletes the Creator definition. `CREATOR_FIELDS` documents the Creator shape.

For a smaller starting point covering only the ShopifyQL half, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on any [tutorial page](https://shopify.dev/docs/apps/build/analytics).

## License

The [MIT License](./LICENSE.md) covers this repository.

# Campaign performance dashboard

An embedded Shopify app that reports whether a marketing campaign worked.

The app sends a marketing funnel with [App Events](https://shopify.dev/docs/apps/build/app-events/analytics), queries that funnel and the store's sales with [ShopifyQL](https://shopify.dev/docs/api/shopifyql), and records the result as annotations and targets on the store's analytics timeline. It also creates QR codes, assigns each one to a campaign, registers it as a marketing activity, and tags every scan with the code's UTM parameters, and Shopify attribution reports the orders shoppers place after scanning.

This repository is the finished app. It starts from the app that [Build a Shopify app using React Router](https://shopify.dev/docs/apps/build/build) produces, and a three-part tutorial series builds the dashboard inside that app, one capability per part.

1. [Configure an app and query a campaign's sales](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-sales) covers the scopes, the ShopifyQL sales queries, and the dimensions your app owns.
2. [Set campaign targets and annotations](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-targets-and-annotations) sets a revenue target and marks the campaign on the store's analytics timeline.
3. [Report on a campaign with App Events](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-app-events) reports your app's marketing events, then queries the funnel beside the sales.

## Setup

You'll need Node 20.19+ or 22.12+, [app development permissions](https://shopify.dev/docs/apps/build/dev-dashboard/user-permissions), a [dev store](https://shopify.dev/docs/apps/build/dev-dashboard/development-stores), and the latest [Shopify CLI](https://shopify.dev/docs/api/shopify-cli).

1. Install Shopify CLI:

   ```shell
   npm install -g @shopify/cli@latest
   ```

2. Clone the repository and install dependencies:

   ```shell
   git clone https://github.com/shopify-playground/example-analytics--campaign-dashboard--react.git
   cd example-analytics--campaign-dashboard--react
   npm install
   ```

3. Create the app record and link this directory to it:

   ```shell
   npm run config:link
   ```

4. Restore `access_scopes.scopes` in `shopify.app.toml`. `config:link` overwrites the line, and a new app record has no scopes to write. An app installed with no scopes fails every query and every write:

   ```toml
   [access_scopes]
   scopes = "read_reports,write_reports,read_analytics_annotations,write_analytics_annotations,write_products,write_customers,write_orders,write_metaobject_definitions,write_metaobjects,write_marketing_events"
   ```

5. Create the local database, then deploy the app, the QR code metaobject definition, and the event declarations:

   ```shell
   npm run setup
   npm run deploy
   ```

6. Start the app, press `p` to open the preview URL, then click **Install app**. The prompt lists the scopes from step 4:

   ```shell
   npm run dev
   ```

The app opens on a campaign list holding two seeded campaigns. Panels read `$0` or show no rows until you request the access below and the store has orders. The declaration from `npm run deploy` takes a few minutes to propagate before an App Events query returns rows.

## Access to request

| Access | What stays empty without it |
|--------|-----------------------------|
| [Level 2 protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) | The campaign detail page. `shopifyqlQuery` returns an access error, and a **Couldn't load sales** banner replaces the panels. The campaign list still loads. |
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

## API version

Two files pin version `2026-10`, the first version with annotations and targets. `shopify.app.toml` sets `api_version` for webhooks, and `app/shopify.server.js` sets `apiVersion` for every Admin API call. Don't lower either one.

ShopifyQL resolves Campaign metaobject columns only on the release-candidate API version, `2027-01`, for now. Until `2026-10` supports them, set `apiVersion` to `2027-01` in both places in `app/shopify.server.js`. Otherwise the product dimension never reads **Queryable** and **Promoted product sales** stays empty.

## Credentials

This repository ships none. `client_id` is empty in `shopify.app.toml`, and `.env` files are gitignored. `config:link` writes your own `client_id`, `application_url`, and `redirect_urls`, and `shopify app dev` supplies `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` to the running process.

Never put a client secret in `shopify.app.toml`. It's a tracked file.

## Use the dashboard

The first load seeds two campaigns, both planned, dated relative to your install:

| Campaign | Window | What it shows |
|----------|--------|---------------|
| `Summer launch` | Opened 20 days ago, a week left | Nine sends dated between 20 and 7 days ago. Step 5 posts them. |
| `Back to school` | Starts in two weeks | Nothing to report. Every panel shows the setup it still needs. |

1. On the campaign list, under **Analytics dimensions**, click **Create dimension** on each of the three rows. Do this once. A report that groups on a dimension returns no rows until the dimension reads **Queryable**.
2. The product row now reads **Analytics off for Campaign**. Click **Turn on analytics** on that row. The admin opens the Campaign type. Turn on **Filter or group data in Analytics**, then reload the app. Only the merchant can change this setting. The row reads **Queryable** about 30 seconds later.
3. Open `Summer launch`. Under **Campaign setup**, click **Select products** and choose up to five, then choose a **Customer segment**.
4. Click **Activate campaign**. Annotations and targets appear on the next render.
5. Click **Send events**. The text above the button names the send and event counts. Posting takes a minute or two, and the funnel panels have numbers a few minutes after that.
6. Click **Open in Analytics** to confirm the annotations landed outside the app.

Targets are optional. Activation creates a target for each amount you set and skips each blank one. The annotations go up either way.

Four more controls write to the same charts. **Close campaign** rewrites the annotation with what the campaign earned and records the last campaign touch before each order. **Cancel campaign** takes the annotations and targets back off the store. **Replan campaign** returns a canceled campaign to planned for a second activation, and **Delete campaign** removes it.

To try the QR code flow, click **QR codes** in the app's navigation and create a code. Under **Campaign**, pick a planned campaign, then save. A planned campaign's page also links to a new code with its campaign picked. A code belongs to one campaign, and the **Campaign** column on the list links to it. **Live on** sets the day the code's mark lands on the timeline. Blank goes live with the campaign. Activating the campaign marks each of its codes on the timeline. With a **QR code target** amount, activation also creates one target per code. Every scan redirects to the product with the code's UTM parameters, and the **QR code sales** panel reports the orders shoppers place after scanning.

Each campaign is an entry of the **Campaign** metaobject type, which the app creates on first load. The admin lists the entries with the store's other metaobjects, and a merchant can edit them there. Re-cloning doesn't reset them. The seed runs once per store. Deleting the seeded campaigns doesn't bring them back.

## Get numbers on the charts

A dev store with no orders reports `$0`. The seed creates campaigns. The sales come from orders you place.

- Place test orders inside `Summer launch`'s window. The nine sends land between 20 and 7 days before you install.
- Cluster the orders in the days right after a send, with the largest cluster in the last few days. Orders placed only in the opening week make every later send read as having moved nothing.
- Create `AVERY10`, `AVERYSUMMER`, and `JUNO15` under **Discounts**, then place storefront orders that use them. **Creator revenue** groups sales by `discount_code`, and that column counts a code only when a buyer enters it at checkout. A discount added to an order in the admin has no code, and the panel stays hidden until one order has a code.

## What it does

An active campaign's page runs the panels in the order a campaign produces evidence. Targets come first, then sales against the period before, the send funnel per channel, revenue grouped by the dimensions this app creates, and a closing summary written back to the store's timeline.

Chips beside each panel title name what produced the number, whether ShopifyQL, App Events, metafields, annotations, or web components.

The [tutorial series](https://shopify.dev/docs/apps/build/analytics) walks through every panel and the query behind it.

## Troubleshooting

| What you see | What it means |
|--------------|---------------|
| A **Couldn't load sales** banner replaces the sales panels | Either the `scopes` line didn't survive `config:link`, or Level 2 access hasn't landed for this app. Reading live analytics needs both `read_reports` and Level 2. |
| Every sales panel reads `$0` | The store has no orders in the campaign's window. |
| `This store can't query App Events yet` | Either `npm run deploy` hasn't propagated, or the organization doesn't have App Events access. |
| `Column Not Found` on an `app_events` query | The declaration hasn't reached the store. Don't send events until it clears. |
| **Creator revenue** doesn't appear | No sale has one of the three codes. A discount added in the admin has no code for analytics to group on. |
| **Promoted product sales** is empty | Analytics is off for the Campaign type, or the setting changed under a minute ago. Turn it on from the product row under **Analytics dimensions**. On API version `2026-10`, see [API version](#api-version). |
| A segment panel is empty | The dimension isn't queryable yet. Create it from **Analytics dimensions**. |
| **Order attribution** is missing after a close | Analytics takes a few minutes to index the order metafields the close wrote. Reload after that. |
| Two campaigns share a product or an order, and one loses its credit | Each product holds one `campaign` reference and each order holds one `campaign_touch` value. The campaign that activates or closes last overwrites the other. Run one campaign per product at a time. |
| A campaign shows a status you didn't set | Entries live on the store, and the admin can edit them. The clone holds none of them. |

## How it's built

The app that [Build a Shopify app using React Router](https://shopify.dev/docs/apps/build/build) produces, with the campaign routes added:

| Path | File |
|------|------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` |

The QR code routes come from that tutorial. `/app/qrcodes` lists the codes, `/app/qrcodes/:id` edits one, and the public `/qrcodes/:id` and `/qrcodes/:id/scan` routes serve the image and record each scan. `app/models/QRCode.server.js` holds their queries, and the codes live in an `$app:qrcode` metaobject that `shopify.app.toml` defines.

GraphQL documents are in `app/campaign-queries.server.js`, campaign entries in `app/campaigns.server.js`, and the App Events client and send plan in `app/app-events.server.js`. Each group of panels is a separate module under `app/panels/`. Event declarations are in `extensions/app-events/shopify.extension.toml`. `shopify.app.toml` holds no credentials.

Each campaign is an entry of the `campaign_dashboard_campaign` metaobject type. `ensureDefinition` creates the type at runtime, because analytics joins only types without the `$app:` prefix. The `qr_code_ids` field holds QR code IDs as text, and an uninstall leaves every entry in place. `CAMPAIGN_FIELDS` documents the shape field by field.

For a smaller starting point covering only the ShopifyQL half, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on any [tutorial page](https://shopify.dev/docs/apps/build/analytics).

## License

Released under the [MIT License](./LICENSE.md).

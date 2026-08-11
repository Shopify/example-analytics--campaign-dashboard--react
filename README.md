# Campaign performance dashboard

An embedded Shopify app that answers whether a marketing campaign worked, and then writes the answer back onto the store's own analytics. It's the companion code for the tutorial [Build a campaign performance dashboard](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

1. [App Events](https://shopify.dev/docs/apps/build/app-events/analytics) report what the app did. Fifteen standard events across email, SMS, push, and lead capture, every one tagged with the same `campaign_id`.
2. [ShopifyQL](https://shopify.dev/docs/api/shopifyql) queries those events back, in the same query language as the store's sales, so the funnel and the revenue read side by side.
3. [Annotations](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsAnnotationCreate) put the verdict on the store's timeline. Every field on an annotation is mutable, so the app writes its marker before the campaign runs and rewrites it afterwards with the result it measured.

## What it does

**Reads sales.** ShopifyQL through the [`shopifyqlQuery`](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/shopifyqlQuery) field, rendered two ways: by reading the structured `tableData` response into Polaris Viz charts, and by embedding [metric cards](https://shopify.dev/docs/api/shopifyql/2026-10/web-components/metric-card) that run their own queries from the browser and share one date picker.

**Measures against goals.** Up to three [analytics targets](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsTargetCreate) per campaign: one store-wide, one scoped with a `filters` expression to the products the campaign pushed, and one scoped to the audience tier it targeted. Shopify generates a `shopifyqlQuery` for each target, so progress comes from a query the app never wrote, and one aliased GraphQL document measures every target in a single request.

**Turns its own metafields into dimensions.** The app stamps `promoted_by` onto the products a campaign pushes and `tier` onto the customers it targets, then offers to make each definition analytics queryable. Once it is, the sales dataset can be grouped by a field the app wrote, so "what did the promoted products earn" becomes a `GROUP BY` rather than a join the app does by hand.

**Reports its own funnel.** Fifteen standard events sent with a `campaign_id` and a `template_id`, queried back with `FROM app_events`. Lead capture and marketing are separate categories in the [standard event registry](https://shopify.dev/docs/apps/build/app-events/analytics/standard-event-registry), and both accept `campaign_id`, so one `WHERE` clause reports the signups that grew the list alongside the sends that followed. Bounces and unsubscribes sit next to opens and clicks, because the stages that go wrong are the ones worth seeing.

**Draws the sequence, not the blast.** A campaign is nine touches over two weeks. Each carries its own `template_id`, so `GROUP BY template_id` returns one row for each send in the order they went out, and the engagement line across them says whether the list was still listening by the last touch. Each channel gets its own funnel chart, and they're deliberately different lengths, because the registry gives email six events, SMS four, and push two.

**Marks the campaign on the store's timeline.** Nine annotations for a campaign sending on all three channels, spanning six types: the campaign itself, the collection going live, the landing page, the discount, one marker per channel, the paid boost, and the creator collaboration. The campaign is open-ended and stays open until it's closed. Everything inside it is a point in time. The types span several categories, so [`ANNOTATE`](https://shopify.dev/docs/api/shopifyql/2026-10/syntax/annotate) can filter them apart.

**Rewrites its marker with the outcome.** Closing the campaign re-measures revenue, the target, and the engagement drop on the server, then sends [`analyticsAnnotationUpdate`](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/analyticsAnnotationUpdate) with a new title, a new description, and an end date. The marker goes up reading `Summer launch` and comes down reading `Summer launch: 169% of target`, written from numbers the app measured rather than numbers a person typed.

**Flags its own incidents.** When bounces cross 2% of the send, the app offers to write an `other` annotation naming the rate and the hard and soft split. A deliverability problem is a reason a week underperformed, and the store's charts are where someone looks for that reason months later.

**Leads with something the user didn't ask for.** Five complete weeks of weekly sales for each product, scanned for the longest unbroken run in either direction, with the annotations from those weeks pinned to the points they explain. A product sliding for three weeks straight is the one worth putting at the top of the page.

**Reads the whole timeline, not just its own markers.** The annotations query filters by date window rather than by source or type, so a sale, a theme change, or a Shopify-generated event in the same week shows up next to the app's markers, each labelled with who wrote it. Reading only your own annotations hides the thing that actually moved the numbers.

## How it's built

This sample is the [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router), written in JavaScript, with two routes added:

| Path | File | What it holds |
|------|------|---------------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` | The campaign list, and the form that creates one. |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` | The dashboard, and every action that writes to the store. |

Every GraphQL document is in `app/campaign-queries.server.js`. Campaign records live in `app/campaigns.server.js`, the App Events client and the send plan in `app/app-events.server.js`, and the event declarations in `extensions/app-events/shopify.extension.toml`. The rest of `app/` is the campaign model the two routes share: channels, audience tiers, annotation categories, and the insight scan.

`shopify.app.toml` sets six access scopes, enables Direct API access so the metric cards can query from the browser, and adds an `analytics_app_events` extension. `@shopify/polaris-viz` draws the charts the app renders itself.

A campaign is a record in one app-data metafield rather than a row in a table, so there's no schema to design and no migration to run. A real app would use its own storage, and `CAMPAIGN_FIELDS` documents the shape field by field.

For a smaller starting point that covers the ShopifyQL half on its own, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and its companion repository, [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Requirements

- A [Shopify Partner account](https://www.shopify.com/partners) and a development store.
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) installed.
- Node.js 20.19 or later, or 22.12 or later.
- [Level 2 access to protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data), which `shopifyqlQuery` requires. Approval can take time, so request it early.
- API version `2026-10` or later. Annotations and targets aren't available before it.
- [App Events in Analytics](https://shopify.dev/docs/apps/build/app-events/analytics) access, which is in developer preview and granted to approved apps. The funnel and sequence panels need it. Every other panel works without it.

## Run locally

### Your own credentials

This repository ships no credentials. `client_id` in `shopify.app.toml` is empty, and there's no `.env` file, because `.env` and `.env.*` are in `.gitignore`.

Step 3 below writes your own `client_id`, `application_url`, and `redirect_urls` into `shopify.app.toml`. Step 5 writes your `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` into `.env`. Both are yours, and neither is committed. Never put a client secret in `shopify.app.toml`, which is a tracked file.

### Steps

1. Clone the repository and install dependencies:

   ```shell
   git clone https://github.com/shopify-playground/example-analytics--campaign-dashboard--react.git
   cd example-analytics--campaign-dashboard--react
   npm install
   ```

2. Create the local SQLite database that holds OAuth sessions:

   ```shell
   npm run setup
   ```

3. Connect the app to your Partner account and choose a development store:

   ```shell
   npm run config:link
   ```

4. Deploy the app configuration so the access scopes, the webhook subscription, and the App Events declarations reach Shopify:

   ```shell
   npm run deploy
   ```

5. Start the app:

   ```shell
   npm run dev
   ```

6. Install the app on your development store when the CLI prompts you, then open it from the store's admin. It opens on the campaign list.

A deployed configuration takes a few minutes to reach the shop. Events that arrive before the declarations are live are marked ineligible for analytics on arrival, and that verdict is never revisited, so wait a few minutes after step 4 before you report a funnel.

## Fill the dashboard

The first load seeds one planned campaign called `Summer launch` over the last two weeks, so the queries return whatever your development store has actually sold rather than nothing at all. Open it from the list.

A planned campaign has written nothing to the store yet. Before launching it:

- Click **Select products** to choose up to five products the campaign promotes. The product target and the `promoted_by` stamp both need them.
- Choose an **Audience** tier. `VIP` and `Lapsed` each add a roster of customers to tag, and a third target once the customer dimension below is queryable. `Everyone` adds neither.
- Under **Dimensions this app owns**, click **Create it as a dimension** on each row. The app creates each definition with the `analyticsQueryable` capability already on. A definition that already exists without the capability gets **Make it queryable** instead.

These two definitions can't be declared in `shopify.app.toml`, and the reason is a pair of rules that meet badly. TOML supports only the `adminFilterable`, `uniqueValues`, and `cartToOrderCopyable` capabilities, so it can't turn `analyticsQueryable` on. A definition declared in TOML is also read-only through the GraphQL Admin API, so `metafieldDefinitionUpdate` can't turn it on afterwards either. A declared definition could never become a dimension, so the app creates its own.

Then click **Launch the campaign**. It reports the funnel, writes every marker, creates the targets, and stamps the products and customers. App Events processes asynchronously, so the funnel and sequence panels stay at zero for a few minutes. Reload until they fill in.

Now run the writes that depend on the result:

- **Close the campaign with its result** rewrites the campaign marker with the revenue it earned, and sets its end date.
- **Raise the goal** appears on a target that's been met, and moves it to the next round number.
- **Mark the day it was hit** records the win as a `revenue_milestone` annotation, in the operations category rather than among the marketing markers.
- **Add a marker to the store's analytics** appears in a banner when the bounce rate crosses 2%.
- **Open these weeks in the store's analytics** leaves the app for the store's own charts, filtered to the campaign's window.
- **Cancel the campaign** removes every marker this app wrote, along with the targets.

Each write re-measures on the server before it commits, so an annotation only lands if the numbers still support it. Open the store's analytics in the Shopify admin after each one to watch it land outside the app. App Events have no delete, so **Cancel the campaign** leaves the funnel numbers in place.

## Run more than one campaign

The form on the campaign list creates a second campaign with its own name, window, channels, products, audience, and goals. Every query, target, and annotation on the dashboard is derived from that record, so a second campaign needs no code change. That's what the two-route split buys: the dashboard reads a campaign rather than a constant.

New campaigns get the next unused integer ID, starting at `4210`. A canceled campaign keeps its record, and its ID stays spent, because event data can't be deleted and a reused ID would inherit the canceled campaign's funnel.

## Things worth knowing before you change the code

**App Events data can't be deleted**, and an idempotency key that's already been used is dropped along with its payload. Give each run its own campaign ID when you change the event payload, or the earlier run's events keep landing in your totals.

**Event metrics are scoped to the app that declared them.** `FROM app_events` resolves for any app, but its columns only exist for the app whose extension declares those events, so running the funnel query from another app or from the CLI returns `Column Not Found`. Query it from this app.

**An event timestamp is a UTC instant, and ShopifyQL buckets it into a day using the shop's timezone.** An event stamped `2026-07-22T00:00:00Z` lands on July 21 for a shop in New York, which drops it out of a window that starts on the 22nd. `sendCampaignFunnel` takes the shop's `ianaTimezone` and anchors each touch to 9am local, so the first send stays inside the window whatever the offset.

**An app-owned metafield namespace is `app--` followed by the app's numeric ID.** The double hyphen isn't something a bare ShopifyQL identifier can hold, so quote the namespace everywhere it appears in a query, or the query fails with `no viable alternative`.

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on the [tutorial page](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

## License

This sample is released under the [MIT License](./LICENSE.md).

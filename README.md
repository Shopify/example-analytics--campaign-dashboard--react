# Campaign performance dashboard

An embedded Shopify app that reports whether a marketing campaign worked, then writes the answer back onto the store's own analytics.

The app reports its own marketing funnel with [App Events](https://shopify.dev/docs/apps/build/app-events/analytics). It queries that funnel and the store's sales with [ShopifyQL](https://shopify.dev/docs/api/shopifyql). It records the outcome as annotations and targets on the store's analytics timeline, where anyone reading the store's reports sees it without opening the app.

This is the companion code for [Build a campaign performance dashboard](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard), which explains why each piece is built the way it is.

## Before you start

Two approvals gate this app, and both take time. Request them before you clone.

| Requirement | What it gates | How to get it |
|-------------|---------------|---------------|
| [Level 2 access to protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data) | Every panel. `shopifyqlQuery` returns no data without it. | Request it in the Partner Dashboard for your app. |
| [App Events in Analytics](https://shopify.dev/docs/apps/build/app-events/analytics) | Four panels: **Campaign events**, **Channel metrics**, **Send performance**, and **Deliverability**. | [Request early access](https://forms.gle/2yLka2Ww3J3cNiGY8). The preview is open to approved apps. |

Without App Events access the app still runs and nothing fails. Sales, targets, the timeline, the insight, and every write to the store all work. The four panels above report `This store can't query App Events yet` and stay empty.

You'll also need:

- A [Shopify Partner account](https://www.shopify.com/partners) and a development store.
- Node.js 20.19 or later, or 22.12 or later.
- API version `2026-10` or later. Annotations and targets aren't available before it.
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) installed globally. Every `npm run` script below shells out to it:

  ```shell
  npm install -g @shopify/cli@latest
  ```

## Run it

```shell
git clone https://github.com/Shopify/example-analytics--campaign-dashboard--react.git
cd example-analytics--campaign-dashboard--react
npm install
npm run config:link   # connect to your Partner account and pick a development store
npm run setup         # create the local SQLite database that holds OAuth sessions
npm run deploy        # release the scopes, the webhook, and the App Events declarations
npm run dev           # start the app, then install it when the CLI prompts you
```

Press `p` to open the app, or open it from the store's admin. It opens on the campaign list.

`npm run deploy` is the step that's easy to skip and hard to diagnose. Nothing reaches Shopify without it, including the App Events declarations that four panels read from.

**Wait a few minutes after `npm run deploy` before you send any events.** A released configuration takes time to reach the store, and an event that arrives before its declaration is live is marked ineligible for analytics on arrival. That verdict is never revisited, and the events can't be deleted or resent under the same keys.

The **Channel metrics** panel is the signal that the declaration reached the store. While it reports it can't reach the dataset, don't send. The Dev Console listing the extension as **App Events** only confirms the CLI knows about it.

### Credentials

This repository ships none. `client_id` in `shopify.app.toml` is empty, and `.env` and `.env.*` are in `.gitignore`. `npm run config:link` writes your own `client_id`, `application_url`, and `redirect_urls` into `shopify.app.toml`, and `shopify app dev` provides `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` to the running process.

Never put a client secret in `shopify.app.toml`. It's a tracked file.

## What you'll see on a fresh development store

The panels query your store's real sales. A development store with no orders reports `$0` everywhere, and that's the app working correctly rather than a broken install.

To get numbers on the charts, place test orders inside `Summer launch`'s window. Its nine sends land between 20 and 7 days before you install. Cluster the orders in the days right after a send rather than spreading them evenly, and put the largest cluster in the last few days, which is where a real campaign spikes on its deadline. Orders placed only in the opening week make every follow-up read as having moved nothing. For **Creator revenue**, create `AVERY10`, `AVERYSUMMER`, and `JUNO15` under **Discounts** in the admin first, then redeem one on each order. The app records which creator hands out which code, and the store's own `discount_code` dimension supplies the revenue.

## Use the dashboard

The first load seeds two campaigns, both planned, dated relative to the day you install:

| Campaign | Window | What it shows |
|----------|--------|---------------|
| `Summer launch` | Opened 20 days ago, a week left | Its nine sends finished a week ago, leaving room for the sales they moved. |
| `Back to school` | Starts in two weeks | Nothing to report. Every panel on its page is the setup it still needs. |

1. On the campaign list, under **Dimensions this app owns**, click **Create it as a dimension** on each of the three rows. One definition covers every campaign, so this is a one-time step. The reports that group on a dimension have nothing to draw until it's queryable.
2. Open `Summer launch`. Under **Campaign setup**, click **Select products** and choose up to five, then choose a **Customer segment**.
3. Click **Launch the campaign**. Markers and targets appear on the next render.
4. Click **Send the campaign's events**. The replay is 643 events and takes a minute or two to post. The funnel panels stay empty for a few more minutes while Shopify ingests them.
5. Click **Open this report in the store's analytics dashboard** to confirm the markers landed outside the app.

Then run the remaining writes and watch each one reach those same charts. **Close the campaign with its result** rewrites the campaign's marker with what it earned and stamps each order with the send it followed. **Cancel the campaign** takes the markers and targets back off the store, and **Plan the campaign again** puts it back to planned so you can launch it a second time.

Campaign records live in an app-data metafield on the store's app installation, not in the local database. Deleting the clone and cloning again doesn't reset them. Canceling a campaign sets its status rather than removing its record, and you can plan it again from its own page. The seed only runs against an empty metafield, and a fresh app installation is what gives you one.

## What each panel shows

A launched campaign opens on what it promised, states what that added up to, then shows the evidence in the order a campaign produces it.

Panels that report a number carry chips beside their title naming what produced it: ShopifyQL, App Events, Metafields, Annotations, or web components. A number the store measured and a number this app reported about itself mean different things.

| Panel | What it shows |
|-------|---------------|
| Campaign setup | Everything launching will write, listed before it writes it. Planned campaigns only. |
| Targets | Progress against up to three targets: one store-wide, one for the promoted products, and one for the targeted segment. Shopify measures each against the store's own sales. |
| Campaign performance | Only the findings that crossed a threshold, such as a target beaten, a list shrinking, or engagement falling off. An empty panel means nothing did. |
| Store totals | Total sales, orders, and average order value on a shared date picker, from [metric cards](https://shopify.dev/docs/api/shopifyql/2026-10/web-components/metric-card). |
| Sales and orders | The campaign's own window against the period before it, with the store's annotations as dots along the bottom of the chart. |
| Campaign events | Sends the replay. The only panel that writes to App Events rather than reading it. |
| Channel metrics | One funnel per channel, from `FROM app_events`. |
| Send performance | Each of the nine sends scored on its own, which is what makes a weak one visible next to the rest. |
| Deliverability | What each channel bounced and what it cost the list. |
| Promoted product sales | The promoted products' share of what the store sold, grouped by the dimension this app created. |
| `<tier>` segment sales | What the targeted customers bought, grouped by the tier written onto them at launch. |
| Order attribution | Orders grouped by the last send that reached the customer before them. |
| Creator revenue | Revenue per discount code, rolled up to the creator who hands the codes out. |
| Store-wide weekly movement | The store's best seller going into the campaign, charted through it against three weeks of lead-in. |
| Closing this campaign | Rewrites the campaign's annotation with what it earned, and stamps each order with the send it followed. |

## Troubleshooting

| What you see | What it means |
|--------------|---------------|
| Every sales panel reads `$0` | The development store has no orders in the campaign's window. Place test orders dated inside it. |
| `This store can't query App Events yet` | Either `npm run deploy` hasn't propagated, or the organization doesn't have App Events access. Wait a few minutes, then check your access. |
| `Column Not Found` on an `app_events` query | The declaration hasn't reached the store. Don't send events until it clears. |
| **Creator revenue** reads `$0` with orders on the chart | The three discount codes don't exist in the admin, or no order redeemed one. A code that was never created reports zero the same way a code nobody used does. |
| **Promoted product sales** or a segment panel is empty | The dimension isn't queryable yet. Create it from **Dimensions this app owns** on the campaign list. |
| A campaign shows a status you didn't set | Records live on the store, not in the clone. See the reseeding note above. |
| An event replay posts but nothing changes | A reused idempotency key is dropped along with its payload. After you change an event payload, bump the `RUN` constant in `app/app-events.server.js`. |

## How it's built

This is the [Shopify React Router app template](https://github.com/Shopify/shopify-app-template-react-router) in JavaScript, with two routes added:

| Path | File | What it holds |
|------|------|---------------|
| `/app/campaigns` | `app/routes/app.campaigns._index.jsx` | The campaign list, and the form that creates one. |
| `/app/campaigns/:id` | `app/routes/app.campaigns.$campaignId.jsx` | The dashboard, and every action that writes to the store. |

Every GraphQL document is in `app/campaign-queries.server.js`. Campaign records live in `app/campaigns.server.js`, and the App Events client and the send plan in `app/app-events.server.js`. The event declarations are in `extensions/app-events/shopify.extension.toml`, not in `shopify.app.toml`. The rest of `app/` is the campaign model the two routes share.

A campaign is a record in one app-data metafield rather than a row in a table. There's no schema to design and no migration to run. A real app would use its own storage. `CAMPAIGN_FIELDS` documents the shape field by field.

For a smaller starting point that covers the ShopifyQL half on its own, see [Build a sales dashboard with the GraphQL Admin API](https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api/build-a-sales-dashboard) and its companion repository, [`example-shopifyql--sales-dashboard--react`](https://github.com/Shopify/example-shopifyql--sales-dashboard--react).

## Contributions

This repository is a documentation sample. It doesn't accept issues or contributions. To report a problem with the tutorial, use the feedback control on the [tutorial page](https://shopify.dev/docs/apps/build/analytics/build-a-campaign-dashboard).

## License

This sample is released under the [MIT License](./LICENSE.md).

# Agent guide

This repository is the sample app for the [campaign dashboard tutorial series](https://shopify.dev/docs/apps/build/analytics) on shopify.dev. It's an embedded Shopify app built with React Router. Read `README.md` for setup.

## Know which part you're on

Each branch holds the app at the end of one tutorial:

| Branch | Tutorial | Present only from this branch on |
|--------|----------|----------------------------------|
| `part-1` | [Query campaign sales](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-sales) | ShopifyQL sales panels, QR codes, analytics dimensions |
| `part-2` | [Add targets and annotations](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-targets-and-annotations) | `app/campaign-targets.server.js`, `app/campaign-mutations.server.js`, `app/campaign-report.server.js` |
| `main` | [Report on a campaign with App Events](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-app-events) | `app/app-events.server.js`, `extensions/app-events/` |

Run `git branch --show-current` before you add a feature. A feature from a later part needs that part's files and scopes.

## Keep the tutorial tags intact

The tutorials on shopify.dev show excerpts of this code. Each excerpt sits between a pair of `START` and `END` comment tags, for example in `app/campaigns.server.js`. Most tags are named `campaign-dashboard.<name>`. The QR code files also keep the tags from the QR code tutorial, such as `save-qrcode`.

- Keep each pair in the same file, and keep the tag names unchanged. A renamed or deleted tag breaks an excerpt on shopify.dev.
- Edit the code between the tags freely.
- Leave the tags out of new code that the tutorials don't show.
- Run `npm run check:markers` after every change. The script lists each file where a tag's `START` and `END` counts differ.

## Run the checks

```shell
npm test
npm run check:markers
npm run build
```

The tests use Vitest. `test/helpers/admin.js` exports `mockAdmin`, which answers GraphQL Admin API calls by operation name and throws on an operation that it doesn't know. Add a handler for each new operation that your code sends.

## Don't change these

- **API version.** `shopify.app.toml` and `app/shopify.server.js` pin `2026-10`. Keep both files on the same version.
- **Runtime metaobject types.** `ensureDefinition` in `app/campaigns.server.js` creates the `campaign_dashboard_campaign` and `campaign_dashboard_creator` types when the app loads. Analytics joins only types without the `$app:` prefix. Keep these types out of `shopify.app.toml`.
- **Reference validations.** A metaobject reference field's validation can't change after the field exists. Add a new field instead of changing the `creators` field.
- **Credentials.** `client_id` is empty in `shopify.app.toml`, and `config:link` fills it in. Never write a client secret, an access token, or a store domain into a tracked file.

## Steps only the merchant can take

- Turn on **Filter or group data in Analytics** on the Campaign type in the Shopify admin. Until then, a ShopifyQL query that groups by the product dimension fails with `Metafield Column Not Found`.
- Request Level 2 protected customer data for the app. Without it, `shopifyqlQuery` returns an access error.
- Request App Events access. Without it, the App Events panels on `main` show the **Campaign events aren't available yet** banner.

## What a development store can't show

- A development store accepts only test payments, and test orders often don't reach the `sales` dataset. Create orders with the GraphQL Admin API's `orderCreate` mutation, with a `processedAt` date inside the campaign's dates.
- **Creator revenue** and **QR code sales** need real checkouts. On a development store, **Creator revenue** lists each code at `$0` and **QR code sales** stays empty, even when the code works.
- The app seeds two campaigns once per store, dated from the first load. App Events queries cover only the last 30 days. The `Summer launch` sends are dated 7 to 20 days before the first load, and the oldest sends drop out of the funnel panels about 10 days later.

## Validate Shopify code

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) to check GraphQL Admin API documents in `app/campaign-queries.server.js` against the `2026-10` schema, and to look up ShopifyQL syntax and schemas.

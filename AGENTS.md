# Agent guide

This repository is the sample app for the [campaign dashboard tutorial series](https://shopify.dev/docs/apps/build/analytics) on shopify.dev. It's an embedded Shopify app built with React Router, Prisma, and Vitest. For setup steps and troubleshooting, read `README.md`.

Use npm. `package-lock.json` is the only tracked lockfile. The app needs Node 20.19 or later, or 22.12 or later.

## Know which part you're on

Each branch holds the app at the end of one tutorial:

| Branch | Tutorial | Present only from this branch on |
|--------|----------|----------------------------------|
| `part-1` | [Query campaign sales](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-sales) | ShopifyQL sales panels, QR codes, analytics dimensions |
| `part-2` | [Add targets and annotations](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-targets-and-annotations) | `app/campaign-targets.server.js`, `app/campaign-mutations.server.js`, `app/campaign-report.server.js`, `app/panels/targets.jsx`, `app/panels/close.jsx`, `app/panels/confirm.jsx`, `test/activation.test.js`, `test/lifecycle.test.js`, `test/targets.test.js`, the `write_reports` and `write_analytics_annotations` scopes |
| `main` | [Report on a campaign with App Events](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-app-events) | `app/app-events.server.js`, `app/panels/app-events.jsx`, `app/panels/incident.jsx`, `extensions/app-events/`, `test/delete.test.js`, `test/send-events.test.js` |

Run `git branch --show-current` before you add a feature. A feature from a later part needs that part's files and scopes.

## Set up and run

```shell
npm ci
npm run config:link
npm run setup
npm run dev
```

After `npm run dev` starts, run the deploy in a second terminal:

```shell
npm run deploy
```

- `npm run config:link` links the directory to an app record and writes `client_id` and the app URLs into `shopify.app.toml`. It also overwrites `access_scopes.scopes`. Restore the committed `scopes` line before you run `npm run dev`.
- `npm run setup` generates the Prisma client and creates the local SQLite database.
- `npm run deploy` rejects the webhook addresses until `npm run dev` replaces the placeholder app URL.
- Without App Events access, `npm run config:link`, `npm run dev`, and `npm run deploy` fail with `Invalid extension type "analytics_app_events"`. Run `rm -rf extensions/app-events` to run the rest of the app. Don't commit the deletion. `git checkout -- extensions/app-events` restores the extension.

## How the app stores campaigns

Prisma stores only Shopify sessions, in SQLite. Every campaign lives on the store. A fresh clone holds no campaign data.

- Each campaign is an entry of the `campaign_dashboard_campaign` metaobject type. `CAMPAIGN_FIELDS` in `app/campaigns.server.js` lists its fields, including the IDs of the annotations and targets that the app writes.
- Each creator is an entry of the `campaign_dashboard_creator` type, with the creator's discount codes.
- Three metafields make sales groupable in ShopifyQL: `campaign` on products, `tier` on customers, and `campaign_touch` on orders. `app/dimensions.server.js` defines them.
- The `last_campaign_id` installation metafield keeps a deleted campaign's ID from coming back. Shopify deletes it at uninstall and keeps the campaign entries. After a reinstall, the app can reuse the ID of a campaign deleted before the uninstall.

## How the campaign page works

- `app/routes/app.campaigns.$campaignId.jsx` renders the campaign page. Its `loader` runs the page's queries, and each module in `app/panels/` renders one group of panels.
- From `part-2` on, the route's `action` reads the form's `intent` field, applies that change, and writes the campaign entry back. Add each new write as a new intent.
- `app/campaign-queries.server.js` holds the campaign GraphQL Admin API documents and the server-side ShopifyQL query builders. The QR code files keep their GraphQL inline.
- Panels that render `s-shopifyql-metric-card` or `s-query-container` build their ShopifyQL in the panel module.
- `runOptional` returns a failed ShopifyQL query as an `unavailable` reason. The panel shows the reason, and the rest of the page still renders. Run each new panel query through `runOptional`.

## Where things live

- `app/routes/` holds the campaign, QR code, and auth routes, and the webhook handlers.
- `app/campaigns.server.js` creates the metaobject types and reads and writes campaign entries.
- `app/models/QRCode.server.js` holds the QR code queries.
- `shopify.app.toml` declares the scopes, the webhooks, and the `$app:qrcode` metaobject.
- `extensions/app-events/shopify.extension.toml` declares the App Events.
- `test/` holds the Vitest suites, and `test/helpers/` holds the shared mocks.

## Match the existing code

- Write JavaScript and JSX as ES modules. The repository has no TypeScript.
- Files that end in `.server.js` run only on the server. Other modules in `app/` can load in the browser.
- Build the UI with Polaris web components, such as `s-section`, `s-stack`, and `s-table`.
- The repository has no lint or format script.

## Run the checks

```shell
npm test
npm run check:markers
npm run build
```

A change is done when all three pass. To run one test file, pass its path:

```shell
npm test -- test/queries.test.js
```

`test/helpers/admin.js` exports `mockAdmin`, which answers GraphQL Admin API calls by operation name and throws on an operation that it doesn't know. Add a handler for each new operation that your code sends.

## Keep the tutorial tags intact

The tutorials on shopify.dev show excerpts of this code. Each excerpt sits between a pair of `START` and `END` comment tags, for example in `app/campaigns.server.js`. Most tag names start with `campaign-dashboard.`, and a few start with `qr-marketing.`. The QR code files also keep the QR code tutorial tags, such as `save-qrcode`.

- Keep each pair in the same file, and keep the tag names unchanged. A renamed or deleted tag breaks an excerpt on shopify.dev.
- Edit the code between the tags freely.
- Leave the tags out of new code that the tutorials don't show.
- Run `npm run check:markers` after every change. The script lists each file where a tag's `START` and `END` counts differ.

## Don't change these

- **API version.** `app/shopify.server.js` pins the GraphQL Admin API to `2026-10`, and `shopify.app.toml` pins webhooks to the same version. Keep both files on the same version.
- **Runtime metaobject types.** `ensureDefinition` in `app/campaigns.server.js` creates the `campaign_dashboard_campaign` and `campaign_dashboard_creator` types when the app loads. Analytics joins only types without the `$app:` prefix. Keep these types out of `shopify.app.toml`.
- **Reference validations.** A metaobject reference field's validation can't change after the field exists. Add a new field instead of changing the `creators` field.
- **Credentials.** The committed `shopify.app.toml` keeps `client_id` empty. Leave the values that `config:link` writes out of commits. Never write a client secret, an access token, or a store domain into a tracked file. `.gitignore` excludes `.env` files.

## Errors that code can't fix

A setting outside the code causes each of these errors. `README.md` covers the steps that clear them.

- Until the merchant turns on **Filter or group data in Analytics** on the Campaign type in the Shopify admin, a ShopifyQL query that groups by the product dimension fails with `Metafield Column Not Found`.
- Until the app has Level 2 protected customer data access for the name, address, phone, and email fields, `shopifyqlQuery` returns an access error.
- Until the organization gets App Events access through the early-access form in `README.md`, Shopify CLI rejects the `analytics_app_events` extension type. Access has no self-serve path.

## What a development store can't show

- A development store accepts only test payments, and test orders often don't reach the `sales` dataset. Create orders with the GraphQL Admin API's `orderCreate` mutation, with a `processedAt` date inside the campaign's dates.
- **Creator revenue** and **QR code sales** need real checkouts. On a development store, **Creator revenue** lists each code at `$0` and **QR code sales** stays empty, even when the code works.
- The app seeds two campaigns once per store, dated from the first load. Deleting them doesn't bring them back.
- App Events queries cover only the last 30 days. The app dates the `Summer launch` sends seven to 20 days before the first load, and the oldest sends drop out of the funnel panels about 10 days later.

## Validate Shopify code

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) to check GraphQL Admin API documents against the `2026-10` schema, and to look up ShopifyQL syntax and schemas. If your agent host doesn't have it, install it with the steps on that page. Hosts that support skills can run:

```shell
npx skills add Shopify/shopify-ai-toolkit
```

## Contributions

This repository doesn't accept issues or pull requests.

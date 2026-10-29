# Campaign dashboard

## Orientation

- The repository is `github.com/Shopify/example-analytics--campaign-dashboard--react`.
- It's the sample app for the [campaign dashboard tutorials](https://shopify.dev/docs/apps/build/analytics): an embedded Shopify app in JavaScript, built with React Router, Prisma, and Vitest.
- `README.md` covers setup, access requests, dev store data, and troubleshooting. Read it before you debug an empty panel.
- Use npm with Node 22.12 or later. `package-lock.json` is the only lockfile.

## Know which part you're on

Each branch holds the app at the end of one tutorial. Make changes on `main`. `part-1` and `part-2` are generated from it. Don't commit to them directly. Run `git branch --show-current` before you add a feature. A later part's feature needs that part's files and scopes.

| Branch | Tutorial | Adds |
|--------|----------|------|
| `part-1` | [Query campaign sales](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-sales) | ShopifyQL sales panels, QR codes, analytics dimensions |
| `part-2` | [Add targets and annotations](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-targets-and-annotations) | Targets, annotations, the campaign lifecycle, the `write_reports` and `write_analytics_annotations` scopes |
| `main` | [Report on a campaign with App Events](https://shopify.dev/docs/apps/build/analytics/campaign-dashboard-app-events) | App Events and `extensions/app-events/` |

## Set up and run

```shell
npm ci
npm run config:link
npm run setup
npm run dev
```

After you change `shopify.app.toml`, run `npm run deploy` in a second terminal while `npm run dev` runs.

A change is done when these pass:

```shell
npm test
npm run check:markers
npm run build
```

## Gotchas

- `npm run config:link` overwrites `access_scopes.scopes` in `shopify.app.toml`. Restore the committed line before `npm run dev`. Never commit the `client_id` or URLs it writes, or any secret, token, or store domain.
- `ensureDefinition` in `app/campaigns.server.js` creates the `campaign_dashboard_campaign` and `campaign_dashboard_creator` metaobject types at runtime. Keep these types out of `shopify.app.toml`, because a merchant can't turn on analytics for an `$app:` type.
- A metaobject reference field's validation can't change after the field exists. Add a new field instead.
- `app/shopify.server.js`, `shopify.app.toml`, and `.graphqlrc.js` all pin API version `2026-10`. Change them together.
- Run each new panel query through `runOptional` in `app/campaign-queries.server.js`. A failed query then shows as unavailable instead of breaking the page.
- `mockAdmin` in `test/helpers/admin.js` throws on an unknown GraphQL operation name. Add a handler for each new operation.
- `npm run lint` reports two errors, in code from the React Router app template and the QR code tutorial. Leave them.

## Tutorial tags

shopify.dev shows excerpts of this code between `START` and `END` comment tags. Don't rename or delete a tag, and keep each pair in one file. Leave tags out of code the tutorials don't show. `npm run check:markers` reports unmatched pairs.

## Validate Shopify code

If the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) is installed, validate GraphQL Admin API documents and ShopifyQL with it.

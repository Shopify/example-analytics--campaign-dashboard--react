import {Fragment, useEffect, useState} from 'react';
import {redirect, useFetcher, useLoaderData, useRouteError} from 'react-router';
import {authenticate} from '../shopify.server';
import {createCampaign, ensureCampaign, readCampaigns} from '../campaigns.server';
import {
  ALL_TARGETS_QUERY,
  progressQuery,
  progressValue,
  runIfSupported,
  runOptional,
  sliceQuery,
} from '../campaign-queries.server';
import {enableDimension, readDimensions} from '../dimensions.server';
import {
  isCalendarDate,
  isPositiveAmount,
  parseCreatorCodes,
  parseProducts,
  safeLocale,
  statusLabel,
} from '../campaigns';
import {AUDIENCE_TIERS, tierLabel} from '../audiences';
import {CHANNELS, CHANNEL_KEYS} from '../channels';

// [START campaign-dashboard.overview-read]
export const loader = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  const {appId, campaigns, appName, userErrors} = await ensureCampaign(admin);

  const [dimensions, targetsBody, sends] = await Promise.all([
    readDimensions(admin, appId),
    runIfSupported(admin, ALL_TARGETS_QUERY),
    runOptional(admin, sliceQuery()),
  ]);

  const owner = new Map();
  for (const campaign of campaigns) {
    for (const id of Object.values(campaign.targets ?? {})) {
      owner.set(id, String(campaign.id));
    }
  }

  // A target with no generated query has nothing to measure it. Drop it from the list.
  const nodes = targetsBody.data?.analyticsTargets?.nodes ?? [];
  const measurable = nodes.filter(
    (target) => target.shopifyqlQuery && owner.has(target.id),
  );
  const progress = measurable.length
    ? ((await (await admin.graphql(progressQuery(measurable))).json()).data ?? {})
    : {};

  // Alias back by position, indexed off `measurable`.
  const targets = measurable.map((target, index) => ({
    campaignId: owner.get(target.id),
    expected: Number(target.expectedValue),
    actual: progressValue(progress[`t${index}`]),
  }));

  return {
    campaigns,
    appName,
    dimensions,
    targets,
    // The admin's locale rides in on the request. Formatting here matches the client.
    locale: safeLocale(new URL(request.url).searchParams.get('locale')),
    sends: sends.tableData.rows ?? [],
    seedErrors: userErrors.map((error) => error.message),
  };
};
// [END campaign-dashboard.overview-read]

// [START campaign-dashboard.spawn-action]
export const action = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  const form = await request.formData();

  // Setup for every campaign, sharing this route's action with the create form.
  if (String(form.get('intent')) === 'enable-dimension') {
    const which = String(form.get('which'));
    const {appId} = await readCampaigns(admin);
    const definition = (await readDimensions(admin, appId))[which];
    if (!definition) return {problems: [`No dimension named ${which}.`]};
    const errors = await enableDimension(admin, definition);
    return errors.length
      ? {problems: errors.map((error) => error.message)}
      : {ok: true};
  }

  const products = parseProducts(form.get('products'));
  const fields = {
    title: String(form.get('title') || '').trim(),
    startDate: String(form.get('startDate') || ''),
    endDate: String(form.get('endDate') || ''),
    // A choice list with `multiple` submits one value for each selection.
    channels: form.getAll('channels').map(String),
    // JSON, because a form can't submit an array of objects.
    products: products ?? [],
    audience: String(form.get('audience') || 'everyone'),
    // Sanitize on the way in. A code that can't be queried shouldn't reach the record.
    creatorCodes: parseCreatorCodes(form.get('creatorCodes')),
    // Blank means no target. Activation skips it.
    revenueTarget: String(form.get('revenueTarget') || '').trim(),
    productTarget: String(form.get('productTarget') || '').trim(),
    audienceTarget: String(form.get('audienceTarget') || '').trim(),
    qrTarget: String(form.get('qrTarget') || '').trim(),
  };

  const problems = [];
  if (!fields.title) problems.push('Enter a campaign name.');
  if (!fields.startDate || !fields.endDate) {
    problems.push('Enter a start date and an end date.');
  } else if (
    !isCalendarDate(fields.startDate) ||
    !isCalendarDate(fields.endDate)
  ) {
    problems.push('Enter valid dates, such as 2026-09-10.');
  } else if (fields.endDate < fields.startDate) {
    problems.push("End date can't be before the start date.");
  }
  if (fields.channels.length === 0) {
    problems.push('Select at least one channel.');
  } else if (fields.channels.some((key) => !CHANNEL_KEYS.includes(key))) {
    problems.push('Select channels from the list.');
  }
  if (products === null) {
    problems.push("Couldn't read the selected products. Select them again.");
  }
  // The tier becomes a ShopifyQL comparison and a target filter, both built as strings.
  // Only a value this app defines can reach them.
  if (!AUDIENCE_TIERS.some((tier) => tier.value === fields.audience)) {
    problems.push('Select a customer segment.');
  }
  // Expected values have to be above zero, and the mutation rejects a zero outright.
  // A blank amount is no target. A filled one has to be one activation can create.
  const amounts = [
    [fields.revenueTarget, 'Store sales target'],
    [fields.productTarget, 'Promoted product target'],
    [fields.audienceTarget, 'Customer segment target'],
    [fields.qrTarget, 'QR code target'],
  ];
  for (const [amount, name] of amounts) {
    if (amount && !isPositiveAmount(amount)) {
      problems.push(`${name} must be greater than 0. Leave it blank for no target.`);
    }
  }
  if (problems.length > 0) return {problems};

  const {campaign, userErrors} = await createCampaign(admin, fields);
  if (userErrors.length > 0) {
    return {problems: userErrors.map((error) => error.message)};
  }

  return redirect(`/app/campaigns/${campaign.id}${new URL(request.url).search}`);
};
// [END campaign-dashboard.spawn-action]

// [START campaign-dashboard.overview-shape]
function writtenBack(campaign) {
  const markers = Object.keys(campaign.markers ?? {}).length;
  const count = Object.keys(campaign.targets ?? {}).length;
  if (markers + count === 0) return 'None';
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `${plural(markers, 'annotation')}, ${plural(count, 'target')}`;
}

function targetProgress(campaign, targets) {
  const mine = targets.filter(
    (target) => target.campaignId === String(campaign.id),
  );
  const expected = mine.reduce((total, target) => total + target.expected, 0);
  if (mine.length === 0 || expected <= 0) return null;
  const actual = mine.reduce(
    (total, target) => total + (target.actual ?? 0),
    0,
  );
  return {count: mine.length, percent: Math.round((actual / expected) * 100)};
}

// Matched on the app too, because IDs aren't unique across apps.
function ownRow(campaign, rows, appName) {
  // Events outlive the record that emitted them, and a reused ID inherits the sends of
  // whatever held it before. The status says whether this one sent.
  if (campaign.status === 'planned') return null;

  return rows.find(
    (entry) =>
      String(entry['campaign_id']) === String(campaign.id) &&
      String(entry['app_name']) === String(appName),
  );
}

function sendsFor(campaign, rows, appName) {
  const row = ownRow(campaign, rows, appName);
  if (!row) return null;
  const emails = Number(row['emails_sent'] ?? 0);
  const opens = Number(row['emails_opened'] ?? 0);
  return {
    sent:
      emails +
      Number(row['sms_messages_sent'] ?? 0) +
      Number(row['push_notifications_sent'] ?? 0),
    openRate: emails > 0 ? Math.round((opens / emails) * 100) : null,
  };
}

// One row per campaign that sent, with the per-channel split beside it.
function messageMix(campaigns, rows, appName) {
  return campaigns
    .map((campaign) => ({campaign, row: ownRow(campaign, rows, appName)}))
    .filter(({row}) => row)
    .map(({campaign, row}) => ({
      title: campaign.title,
      email: Number(row['emails_sent'] ?? 0),
      sms: Number(row['sms_messages_sent'] ?? 0),
      push: Number(row['push_notifications_sent'] ?? 0),
    }));
}

// The store from the earliest campaign onwards, floored so an old campaign can't ask
// for a daily series over years of history. ShopifyQL resolves the relative token in
// the store's timezone.
const OVERVIEW_DAYS = 90;

function overviewSince(campaigns) {
  const earliest = campaigns.map((campaign) => campaign.startDate).sort()[0];
  if (!earliest) return null;
  const floor = new Date(Date.now() - OVERVIEW_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  return earliest < floor ? `-${OVERVIEW_DAYS}d` : earliest;
}
// [END campaign-dashboard.overview-shape]

export default function CampaignsIndex() {
  const {campaigns, appName, dimensions, targets, locale, sends, seedErrors} =
    useLoaderData();
  const fetcher = useFetcher();
  const [products, setProducts] = useState([]);
  const [channels, setChannels] = useState(CHANNEL_KEYS);
  const [composing, setComposing] = useState(false);
  const problems = fetcher.data?.problems ?? [];
  const saving = fetcher.state !== 'idle';
  const integer = (value) => new Intl.NumberFormat(locale).format(value ?? 0);

  // Local midnight. A bare date string is UTC, and formats a day early west of it.
  const shortDate = (day) =>
    new Intl.DateTimeFormat(locale, {month: 'short', day: 'numeric'}).format(
      new Date(`${day}T00:00:00`),
    );

  // [START campaign-dashboard.overview-graphics]
  // A metric card needs `window.shopify.shopifyQL`, installed after load. Poll
  // until it lands.
  const [cardReady, setCardReady] = useState(false);
  useEffect(() => {
    const poll = setInterval(() => {
      if (window.shopify?.shopifyQL) {
        setCardReady(true);
        clearInterval(poll);
      }
    }, 100);
    return () => clearInterval(poll);
  }, []);

  const since = overviewSince(campaigns);
  const cardQuery = (metric) =>
    [
      'FROM sales',
      `SHOW ${metric}`,
      'TIMESERIES day',
      `SINCE ${since} UNTIL today`,
      'WITH TOTALS, PERCENT_CHANGE',
      'COMPARE TO previous_period',
      `VISUALIZE ${metric} TYPE line`,
    ].join(' ');

  // Nothing sent is a table of zeros. Don't draw one.
  const mix = messageMix(campaigns, sends, appName);
  const anySends = mix.some((row) => row.email + row.sms + row.push > 0);
  // [END campaign-dashboard.overview-graphics]

  // The link needs a campaign to point at. Prefer an active one.
  const reported =
    campaigns.find((campaign) => campaign.status !== 'planned') ?? campaigns[0];

  // [START campaign-dashboard.product-picker]
  // The app never builds a product list.
  async function pickProducts() {
    const selection = await shopify.resourcePicker({
      type: 'product',
      // Reopening with the current selection keeps the checkboxes in step.
      selectionIds: products.map((product) => ({id: product.id})),
      multiple: 5,
    });

    // Canceling returns undefined. Don't clear the selection.
    if (!selection) return;

    // Keep both. A target filters on the GID and the annotations use the title.
    setProducts(
      selection.map((product) => ({id: product.id, title: product.title})),
    );
  }
  // [END campaign-dashboard.product-picker]

  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('products', JSON.stringify(products));
    // The choice list submits under its `name`. Clear it, or channels arrive twice.
    form.delete('channels');
    for (const channel of channels) form.append('channels', channel);
    fetcher.submit(form, {method: 'post'});
  }

  return (
    <s-page heading="Campaigns">
      {composing ? (
        <s-button slot="secondary-actions" onClick={() => setComposing(false)}>
          Cancel
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => setComposing(true)}
        >
          New campaign
        </s-button>
      )}

      {composing && (
        // The form is one box to the page layout, and the sections inside it
        // lose their spacing. `display: contents` hands them back to the page.
        <form onSubmit={submit} style={{display: 'contents'}}>
          {/* [START campaign-dashboard.spawn-form] */}
          <s-section heading="Campaign details">
            <div style={{height: '12px'}} />
            {problems.length > 0 && (
              <s-banner tone="critical" heading="Campaign not created">
                <s-unordered-list>
                  {problems.map((problem) => (
                    <s-list-item key={problem}>{problem}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            )}

            <s-stack direction="block" gap="base">
              <s-text-field
                label="Campaign name"
                name="title"
                placeholder="Summer launch"
                details="Appears in each annotation title."
              />
              <s-stack direction="inline" gap="base">
                <s-date-field label="Start date" name="startDate" />
                <s-date-field label="End date" name="endDate" />
              </s-stack>

              <s-select
                label="Customer segment"
                name="audience"
                details="Activation writes the segment to a metafield on each customer in the segment. The customer segment target measures sales to the segment."
              >
                {AUDIENCE_TIERS.map((tier) => (
                  <s-option key={tier.value} value={tier.value}>
                    {tier.label}
                  </s-option>
                ))}
              </s-select>

              {/* The codes exist in Discounts. This records who hands each code out. */}
              <s-text-field
                label="Creator codes"
                name="creatorCodes"
                placeholder="AVERY10:Avery, JUNO15:Juno"
                details="Enter CODE:Creator pairs. Separate the pairs with commas. A creator can have more than one code."
              />

              {/* Each amount becomes a target at activation. Leave one blank for no target. */}
              <s-money-field
                label="Store sales target"
                name="revenueTarget"
                placeholder="5000.00"
                details="Leave blank for no target."
              />
              <s-money-field
                label="Promoted product target"
                name="productTarget"
                placeholder="5000.00"
                details="Sales of the promoted products."
              />
              <s-money-field
                label="Customer segment target"
                name="audienceTarget"
                placeholder="2500.00"
                details="Sales to the customer segment."
              />
              <s-money-field
                label="QR code target"
                name="qrTarget"
                placeholder="1000.00"
                details="One target for each QR code assigned to this campaign."
              />

            </s-stack>
          </s-section>
          {/* [END campaign-dashboard.spawn-form] */}

          {/* The form is `display: contents`, so a spacer lands between the cards. */}
          <div style={{height: '12px'}} />

          {/* [START campaign-dashboard.picker-render] */}
          <s-section heading="Promoted products">
            <div style={{height: '12px'}} />
            <s-paragraph>
              Select up to 5 products. The promoted product target measures
              sales of these products.
            </s-paragraph>
            {products.length > 0 && (
              <s-unordered-list>
                {products.map((product) => (
                  <s-list-item key={product.id}>{product.title}</s-list-item>
                ))}
              </s-unordered-list>
            )}
            <s-button onClick={pickProducts}>
              {products.length > 0 ? 'Change products' : 'Select products'}
            </s-button>
          </s-section>
          {/* [END campaign-dashboard.picker-render] */}

          <div style={{height: '12px'}} />

          {/* [START campaign-dashboard.channel-picker] */}
          {/* Each channel reports a different set of stages, and a different funnel. */}
          <s-section heading="Channels">
            <div style={{height: '12px'}} />
            <s-choice-list
              label="Send on"
              name="channels"
              multiple
              onChange={(event) => setChannels([...event.currentTarget.values])}
            >
              {CHANNEL_KEYS.map((key) => (
                <s-choice
                  key={key}
                  value={key}
                  defaultSelected={channels.includes(key) || undefined}
                >
                  {CHANNELS[key].label}
                  <s-text slot="details">
                    Reports{' '}
                    {CHANNELS[key].stages
                      .map((stage) => stage.label.toLowerCase())
                      .join(', ')}
                    .
                  </s-text>
                </s-choice>
              ))}
            </s-choice-list>
          </s-section>
          {/* [END campaign-dashboard.channel-picker] */}

          <div style={{height: '12px'}} />
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" type="submit" loading={saving}>
              Create campaign
            </s-button>
          </s-stack>
          <div style={{height: '12px'}} />
        </form>
      )}

      {/* [START campaign-dashboard.overview-card-render] */}
      {since && (
        <s-section heading="Store sales overview">
          <div style={{height: '12px'}} />
          {cardReady ? (
            <s-metrics-bar accessibilityLabel="Store sales over the campaign period">
              <s-shopifyql-metric-card
                heading="Total sales"
                query={cardQuery('total_sales')}
              />
              <s-shopifyql-metric-card
                heading="Orders"
                query={cardQuery('orders')}
              />
              <s-shopifyql-metric-card
                heading="Average order value"
                query={cardQuery('average_order_value')}
              />
            </s-metrics-bar>
          ) : (
            <s-metrics-bar loading accessibilityLabel="Loading store sales" />
          )}
        </s-section>
      )}
      {/* [END campaign-dashboard.overview-card-render] */}

      <s-section>
        {seedErrors.length > 0 && (
          <s-banner
            tone="critical"
            heading="Campaign setup failed"
          >
            <s-unordered-list>
              {seedErrors.map((problem) => (
                <s-list-item key={problem}>{problem}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}
        {campaigns.length === 0 ? (
          <s-paragraph>No campaigns yet.</s-paragraph>
        ) : (
          // [START campaign-dashboard.overview-render]
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Campaign</s-table-header>
              <s-table-header listSlot="labeled">Dates</s-table-header>
              <s-table-header listSlot="labeled">Segment and channels</s-table-header>
              <s-table-header listSlot="labeled">Messages sent</s-table-header>
              <s-table-header listSlot="labeled">Target progress</s-table-header>
              <s-table-header listSlot="labeled">Annotations and targets</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {campaigns.map((campaign) => {
                const reach = sendsFor(campaign, sends, appName);
                const target = targetProgress(campaign, targets);
                return (
                  <s-table-row key={campaign.id}>
                    <s-table-cell>
                      <s-link href={`/app/campaigns/${campaign.id}`}>
                        {campaign.title}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>
                      {shortDate(campaign.startDate)} to{' '}
                      {shortDate(campaign.endDate)}
                    </s-table-cell>
                    <s-table-cell>
                      {tierLabel(campaign.audience)} on{' '}
                      {(campaign.channels ?? [])
                        .map((key) => CHANNELS[key]?.label ?? key)
                        .join(', ')}
                    </s-table-cell>
                    <s-table-cell>
                      {reach ? (
                        <Fragment>
                          {integer(reach.sent)} messages
                          {reach.openRate !== null &&
                            `, ${reach.openRate}% email open rate`}
                        </Fragment>
                      ) : (
                        <s-text color="subdued">Nothing sent</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {target ? (
                        <s-text tone={target.percent >= 100 ? 'success' : 'info'}>
                          {target.percent}% across {target.count}{' '}
                          {target.count === 1 ? 'target' : 'targets'}
                        </s-text>
                      ) : (
                        <s-text color="subdued">None</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>{writtenBack(campaign)}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          {
                            planned: 'info',
                            running: 'caution',
                            closed: 'success',
                            canceled: 'critical',
                          }[campaign.status]
                        }
                      >
                        {statusLabel(campaign.status)}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
          // [END campaign-dashboard.overview-render]
        )}
      </s-section>

      {/* [START campaign-dashboard.overview-chart-render] */}
      {anySends && (
        <s-section heading="Messages sent by campaign">
          <div style={{height: '12px'}} />
          <s-paragraph>
            Messages sent in the last 29 days. App Events keeps 30 days of
            data. Older campaigns don't appear.
          </s-paragraph>
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Campaign</s-table-header>
              <s-table-header listSlot="labeled">Email</s-table-header>
              <s-table-header listSlot="labeled">SMS</s-table-header>
              <s-table-header listSlot="labeled">Push</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {mix.map((row) => (
                <s-table-row key={row.title}>
                  <s-table-cell>{row.title}</s-table-cell>
                  <s-table-cell>{integer(row.email)}</s-table-cell>
                  <s-table-cell>{integer(row.sms)}</s-table-cell>
                  <s-table-cell>{integer(row.push)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
      {/* [END campaign-dashboard.overview-chart-render] */}

      {/* [START campaign-dashboard.metafield-dimension-render] */}
      <s-section heading="Analytics dimensions">
        <div style={{height: '12px'}} />
        <s-paragraph>
          The app writes campaign values to products, customers, and orders as
          metafields. Create a dimension from each metafield. Campaign reports
          group sales by each dimension. Each dimension works for every
          campaign. Turn on analytics for the Campaign metaobject to use the
          product dimension.
        </s-paragraph>
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Dimension</s-table-header>
            <s-table-header listSlot="labeled">Status</s-table-header>
            <s-table-header listSlot="labeled">Report</s-table-header>
            <s-table-header listSlot="inline" />
          </s-table-header-row>
          <s-table-body>
            {['product', 'customer', 'order'].map((which) => {
              const definition = dimensions[which];
              return (
                <s-table-row key={which}>
                  <s-table-cell>
                    <s-text>{definition.dimension}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {definition.enabled
                      ? 'Queryable'
                      : !definition.defined
                        ? 'Not created'
                        : definition.reference
                          ? 'Analytics off for Campaign'
                          : definition.eligible
                            ? 'Created, not queryable'
                            : 'Not eligible. Check the field type and owner type.'}
                  </s-table-cell>
                  <s-table-cell>
                    {reported && definition.enabled ? (
                      <s-link
                        href={`/app/campaigns/${reported.id}#${definition.anchor}`}
                      >
                        {definition.report}
                      </s-link>
                    ) : (
                      definition.report
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      {!definition.enabled &&
                        (!definition.defined ||
                          (definition.eligible && !definition.reference)) && (
                          <s-button
                            loading={saving}
                            onClick={() =>
                              fetcher.submit(
                                {intent: 'enable-dimension', which},
                                {method: 'post'},
                              )
                            }
                          >
                            {definition.defined
                              ? 'Enable as dimension'
                              : 'Create dimension'}
                          </s-button>
                        )}
                      {definition.href && (
                        <s-link href={definition.href} target="_blank">
                          {definition.reference && definition.defined && !definition.enabled
                            ? 'Turn on analytics'
                            : 'View definition'}
                        </s-link>
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-section>
      {/* [END campaign-dashboard.metafield-dimension-render] */}
    </s-page>
  );
}

// React Router replaces the nearest route with a boundary. Without one here, a failed
// load takes AppProvider and the app's navigation with it.
export function ErrorBoundary() {
  const error = useRouteError();
  const detail = error?.data ?? error?.message ?? 'The load failed.';
  return (
    <s-page heading="Campaigns">
      <s-section>
        <s-banner tone="critical" heading="Couldn't load campaigns">
          <s-paragraph>{String(detail)}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}

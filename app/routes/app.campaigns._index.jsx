import {Fragment, useEffect, useState} from 'react';
import {redirect, useFetcher, useLoaderData} from 'react-router';
import {BarChart, PolarisVizProvider} from '@shopify/polaris-viz';
import '@shopify/polaris-viz/build/esm/styles.css';
import '../chart-tooltip.css';
import {authenticate} from '../shopify.server';
import {createCampaign, ensureCampaign} from '../campaigns.server';
import {
  ALL_TARGETS_QUERY,
  progressQuery,
  progressValue,
  runOptional,
  sliceQuery,
} from '../campaign-queries.server';
import {enableDimension, readDimensions} from '../dimensions.server';
import {parseCreatorCodes} from '../campaigns';
import {AUDIENCE_TIERS, isTargetedTier, tierLabel} from '../audiences';
import {CHANNELS, CHANNEL_KEYS} from '../channels';

// [START campaign-dashboard.overview-read]
// Every campaign's progress in a fixed number of requests. Neither read grows when
// the store adds a campaign.
export const loader = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  const {campaigns, appId, appName, userErrors} = await ensureCampaign(admin);

  const [dimensions, targetsBody, sends] = await Promise.all([
    readDimensions(admin, appId),
    admin.graphql(ALL_TARGETS_QUERY).then((response) => response.json()),
    runOptional(admin, sliceQuery()),
  ]);

  // A target with no generated query can't be measured. Dropped, not counted as zero.
  const nodes = targetsBody.data?.analyticsTargets?.nodes ?? [];
  const measurable = nodes.filter((target) => target.shopifyqlQuery);
  const progress = measurable.length
    ? ((await (await admin.graphql(progressQuery(measurable))).json()).data ?? {})
    : {};

  // Alias back by position, indexed off `measurable` rather than a filtered copy.
  const started = new Set(campaigns.map((campaign) => campaign.startDate));
  const targets = measurable
    .map((target, index) => ({
      startDate: target.startDate,
      expected: Number(target.expectedValue),
      actual: progressValue(progress[`t${index}`]),
    }))
    .filter((target) => started.has(target.startDate));

  return {
    campaigns,
    appName,
    dimensions,
    targets,
    // The admin's locale rides in on the request. Formatting here matches the client.
    locale: new URL(request.url).searchParams.get('locale') ?? 'en',
    sends: sends.tableData.rows ?? [],
    seedErrors: userErrors.map((error) => error.message),
  };
};
// [END campaign-dashboard.overview-read]

// [START campaign-dashboard.spawn-action]
// Creating a campaign writes a record and nothing else. The launch does the rest.
export const action = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  const form = await request.formData();

  // Setup for every campaign, sharing this route's action with the create form.
  if (String(form.get('intent')) === 'enable-dimension') {
    const {appId} = await ensureCampaign(admin);
    const which = String(form.get('which'));
    const definition = (await readDimensions(admin, appId))[which];
    if (!definition) return {problems: [`No dimension named ${which}.`]};
    const errors = await enableDimension(admin, definition);
    return errors.length
      ? {problems: errors.map((error) => error.message)}
      : {ok: true};
  }

  const fields = {
    title: String(form.get('title') || '').trim(),
    startDate: String(form.get('startDate') || ''),
    endDate: String(form.get('endDate') || ''),
    // A choice list with `multiple` submits one value for each selection.
    channels: form.getAll('channels').map(String),
    // JSON, because a form can't carry an array of objects.
    products: JSON.parse(String(form.get('products') || '[]')),
    audience: String(form.get('audience') || 'everyone'),
    // Sanitized on the way in. A code that can't be queried shouldn't reach the record.
    creatorCodes: parseCreatorCodes(form.get('creatorCodes')),
    revenueTarget: String(form.get('revenueTarget') || '0'),
    productTarget: String(form.get('productTarget') || '0'),
    audienceTarget: String(form.get('audienceTarget') || '0'),
  };

  const problems = [];
  if (!fields.title) problems.push('Give the campaign a name.');
  if (!fields.startDate || !fields.endDate) {
    problems.push('Set both a start and an end date.');
  } else if (fields.endDate < fields.startDate) {
    problems.push('The campaign ends before it starts.');
  }
  if (fields.channels.length === 0) {
    problems.push('Pick at least one channel to send on.');
  }
  // Expected values have to be above zero, and the mutation rejects rather than clamps.
  // Check each amount the launch will turn into a target.
  if (Number(fields.revenueTarget) <= 0) {
    problems.push('The store-wide revenue target has to be more than zero.');
  }
  if (fields.products.length > 0 && Number(fields.productTarget) <= 0) {
    problems.push('The promoted product target has to be more than zero.');
  }
  if (isTargetedTier(fields.audience) && Number(fields.audienceTarget) <= 0) {
    problems.push(
      `The ${tierLabel(fields.audience)} segment target has to be more than zero.`,
    );
  }
  if (problems.length > 0) return {problems};

  const {campaign, userErrors} = await createCampaign(admin, fields);
  if (userErrors.length > 0) {
    return {problems: userErrors.map((error) => error.message)};
  }

  return redirect(`/app/campaigns/${campaign.id}`);
};
// [END campaign-dashboard.spawn-action]

// [START campaign-dashboard.overview-shape]
// What the campaign has put on the store, which is what launching produces.
function writtenBack(campaign) {
  const markers = Object.keys(campaign.markers ?? {}).length;
  const count = Object.keys(campaign.targets ?? {}).length;
  if (markers + count === 0) return 'Nothing yet';
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `${plural(markers, 'annotation')}, ${plural(count, 'target')}`;
}

// Every target the campaign created, as one share.
function targetProgress(campaign, targets) {
  const mine = targets.filter(
    (target) => target.startDate === campaign.startDate,
  );
  const expected = mine.reduce((total, target) => total + target.expected, 0);
  if (mine.length === 0 || expected <= 0) return null;
  const actual = mine.reduce(
    (total, target) => total + (target.actual ?? 0),
    0,
  );
  return {count: mine.length, percent: Math.round((actual / expected) * 100)};
}

// `campaign_id` comes back as a string. Matched on the app too, because IDs aren't
// unique across apps.
function ownRow(campaign, rows, appName) {
  // Events outlive the record that emitted them, and a reused ID inherits the sends of
  // whatever held it before. The status, not the dates, says whether this one sent.
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
    sent: emails + Number(row['sms_messages_sent'] ?? 0),
    openRate: emails > 0 ? Math.round((opens / emails) * 100) : null,
  };
}

// A stacked bar takes one entry per series. The rows get pivoted, and channels stack.
// Sent against opened wouldn't, because opens are a subset of the sends.
function messageMix(campaigns, rows, appName) {
  // Campaigns with sends to report, rather than an empty bar for the rest.
  const sending = campaigns.filter((campaign) => ownRow(campaign, rows, appName));

  return [
    {name: 'Email', column: 'emails_sent'},
    {name: 'SMS', column: 'sms_messages_sent'},
  ].map(({name, column}) => ({
    name,
    data: sending.map((campaign) => ({
      key: campaign.title,
      value: Number(ownRow(campaign, rows, appName)?.[column] ?? 0),
    })),
  }));
}

// The store from the earliest campaign onwards, which is the period the list covers.
function earliestStart(campaigns) {
  return campaigns.map((campaign) => campaign.startDate).sort()[0] ?? null;
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
  // Polaris Viz measures the element it draws into, and a metric card needs
  // `window.shopify.shopifyQL`. Two flags, because they turn true at different moments.
  const [isClient, setIsClient] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  useEffect(() => setIsClient(true), []);
  useEffect(() => {
    const poll = setInterval(() => {
      if (window.shopify?.shopifyQL) {
        setCardReady(true);
        clearInterval(poll);
      }
    }, 100);
    return () => clearInterval(poll);
  }, []);

  const since = earliestStart(campaigns);
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

  // Nothing sent is a chart of two empty bars. Don't draw one.
  const mix = messageMix(campaigns, sends, appName);
  const anySends = mix.some((series) =>
    series.data.some((point) => point.value > 0),
  );
  // [END campaign-dashboard.overview-graphics]

  // The link needs a campaign to point at. Prefer one that launched.
  const reported =
    campaigns.find((campaign) => campaign.status !== 'planned') ?? campaigns[0];

  // [START campaign-dashboard.product-picker]
  // The store's own product search. The app never builds a product list of its own.
  async function pickProducts() {
    const selection = await shopify.resourcePicker({
      type: 'product',
      // Reopening with the current selection keeps the checkboxes in step.
      selectionIds: products.map((product) => ({id: product.id})),
      multiple: 5,
    });

    // Canceling returns undefined, not an empty array. Don't clear the selection.
    if (!selection) return;

    // Both: a target filters on the GID, the annotations are written from the title.
    setProducts(
      selection.map((product) => ({id: product.id, title: product.title})),
    );
  }
  // [END campaign-dashboard.product-picker]

  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('products', JSON.stringify(products));
    // The choice list submits under its own name. Clear it, or channels arrive twice.
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
          Create campaign
        </s-button>
      )}

      {/* [START campaign-dashboard.overview-card-render] */}
      {/* Each card runs its own ShopifyQL from the browser. */}
      {since && (
        <s-section heading="The store while these campaigns run">
          {cardReady ? (
            <s-metrics-bar accessibilityLabel="Store totals since the earliest campaign started">
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
            <s-metrics-bar loading accessibilityLabel="Loading store totals" />
          )}
        </s-section>
      )}
      {/* [END campaign-dashboard.overview-card-render] */}

      <s-section>
        {seedErrors.length > 0 && (
          <s-banner
            tone="critical"
            heading="The first campaign couldn't be saved"
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
              <s-table-header listSlot="labeled">Customer segment</s-table-header>
              <s-table-header listSlot="labeled">Sent</s-table-header>
              <s-table-header listSlot="labeled">Targets</s-table-header>
              <s-table-header listSlot="labeled">On the store</s-table-header>
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
                            `, ${reach.openRate}% opened`}
                        </Fragment>
                      ) : (
                        <s-text color="subdued">Nothing sent</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {target ? (
                        <s-text
                          progress={
                            target.percent >= 100 ? 'complete' : 'partiallyComplete'
                          }
                          tone={target.percent >= 100 ? 'success' : 'info'}
                        >
                          {target.percent}% of {target.count}
                        </s-text>
                      ) : (
                        <s-text color="subdued">Not set yet</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>{writtenBack(campaign)}</s-table-cell>
                    <s-table-cell>
                      <s-badge>{campaign.status}</s-badge>
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
      {/* One bar per campaign, over rows the page already loaded. */}
      {isClient && anySends && (
        <s-section heading="Messages sent by campaign">
          <s-paragraph>
            Every campaign this app sent for, over the last 29 days.
            Attributes on App Events reach back 30 days. A campaign that ran
            before then reports nothing here.
          </s-paragraph>
          <div className="chart-tooltip-fix" style={{height: '220px'}}>
            <PolarisVizProvider>
              <BarChart
                direction="horizontal"
                type="stacked"
                data={mix}
                theme="Light"
              />
            </PolarisVizProvider>
          </div>
        </s-section>
      )}
      {/* [END campaign-dashboard.overview-chart-render] */}

      {/* [START campaign-dashboard.metafield-dimension-render] */}
      {/* A metafield the app owns is a dimension only once it's been asked for. */}
      <s-section heading="Dimensions this app owns">
        <s-paragraph>
          One definition per dimension, not one per campaign. The campaign is
          the value in the column, which is what lets a single dimension report
          every campaign's split. Creating it here lets the store group its own
          sales by something this app knows.
        </s-paragraph>
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Dimension</s-table-header>
            <s-table-header listSlot="labeled">State</s-table-header>
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
                        ? 'Not created yet'
                        : definition.eligible
                          ? 'Created, not yet queryable'
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
                        (!definition.defined || definition.eligible) && (
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
                              ? 'Make it queryable'
                              : 'Create it as a dimension'}
                          </s-button>
                        )}
                      {definition.href && (
                        <s-link href={definition.href} target="_blank">
                          View definition
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

      {composing && (
        <form onSubmit={submit}>
          {/* [START campaign-dashboard.spawn-form] */}
          <s-section heading="Create a campaign">
            {problems.length > 0 && (
              <s-banner tone="critical" heading="Fix these first">
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
                details="Used in the title of every annotation the campaign writes."
              />
              <s-stack direction="inline" gap="base">
                <s-date-field label="Starts" name="startDate" />
                <s-date-field label="Ends" name="endDate" />
              </s-stack>

              <s-select
                label="Customer segment"
                name="audience"
                details="Written onto each customer at launch, and what the segment target is measured against."
              >
                {AUDIENCE_TIERS.map((tier) => (
                  <s-option key={tier.value} value={tier.value}>
                    {tier.label}
                  </s-option>
                ))}
              </s-select>

              {/* The codes exist in Discounts. Who hands each out is what's recorded. */}
              <s-text-field
                label="Creator codes"
                name="creatorCodes"
                placeholder="AVERY10:Avery, JUNO15:Juno"
                details="Code and creator, comma separated. One creator can hold several codes."
              />

              {/* Each becomes a target at launch. */}
              <s-money-field
                label="Store-wide revenue target"
                name="revenueTarget"
                placeholder="5000.00"
              />
              <s-money-field
                label="Promoted product target"
                name="productTarget"
                placeholder="5000.00"
                details="Measured with a filter on the products below."
              />
              <s-money-field
                label="Customer segment target"
                name="audienceTarget"
                placeholder="2500.00"
                details="Measured with a filter on the segment above."
              />

              <s-button variant="primary" type="submit" loading={saving}>
                Create campaign
              </s-button>
            </s-stack>
          </s-section>
          {/* [END campaign-dashboard.spawn-form] */}

          {/* [START campaign-dashboard.picker-render] */}
          <s-section heading="Promoted products">
            <s-paragraph>
              The products this campaign pushes. Their IDs filter the promoted
              product target, and their titles name the product launch annotation.
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

          {/* [START campaign-dashboard.channel-picker] */}
          {/* Each channel reports a different set of stages, and a different funnel. */}
          <s-section heading="Channels">
            <s-choice-list
              label="Send on"
              name="channels"
              multiple
              onChange={(event) => setChannels([...event.currentTarget.values])}
            >
              {CHANNEL_KEYS.map((key) => (
                // `selected` is read-only on a choice. `defaultSelected` sets it.
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
        </form>
      )}
    </s-page>
  );
}

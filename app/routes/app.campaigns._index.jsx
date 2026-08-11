import {useState} from 'react';
import {redirect, useFetcher, useLoaderData} from 'react-router';
import {authenticate} from '../shopify.server';
import {createCampaign, ensureCampaign} from '../campaigns.server';
import {AUDIENCE_TIERS} from '../audiences';
import {CHANNELS, CHANNEL_KEYS} from '../channels';

export const loader = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  const {campaigns, userErrors} = await ensureCampaign(admin);
  return {campaigns, seedErrors: userErrors.map((error) => error.message)};
};

// [START campaign-dashboard.spawn-action]
// Creating a campaign writes a record and nothing else. Everything that touches the
// store waits for the launch, so a campaign can be thrown away without leaving a mark.
export const action = async ({request}) => {
  const {admin} = await authenticate.admin(request);
  const form = await request.formData();

  const fields = {
    title: String(form.get('title') || '').trim(),
    startDate: String(form.get('startDate') || ''),
    endDate: String(form.get('endDate') || ''),
    // A choice list with `multiple` submits one value for each selection.
    channels: form.getAll('channels').map(String),
    // The picker's selection rides along as JSON, because a form can't carry an
    // array of objects.
    products: JSON.parse(String(form.get('products') || '[]')),
    audience: String(form.get('audience') || 'everyone'),
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
  // A target's expected value has to be greater than zero, and the mutation rejects it
  // rather than clamping, so catch it before the launch.
  if (Number(fields.revenueTarget) <= 0) {
    problems.push('The revenue goal has to be more than zero.');
  }
  if (problems.length > 0) return {problems};

  const {campaign, userErrors} = await createCampaign(admin, fields);
  if (userErrors.length > 0) {
    return {problems: userErrors.map((error) => error.message)};
  }

  return redirect(`/app/campaigns/${campaign.id}`);
};
// [END campaign-dashboard.spawn-action]

export default function CampaignsIndex() {
  const {campaigns, seedErrors} = useLoaderData();
  const fetcher = useFetcher();
  const [products, setProducts] = useState([]);
  const [channels, setChannels] = useState(CHANNEL_KEYS);
  const problems = fetcher.data?.problems ?? [];
  const creating = fetcher.state !== 'idle';

  // [START campaign-dashboard.product-picker]
  // The store's own product search, opened from the app, so the app never builds a
  // product list of its own.
  async function pickProducts() {
    const selection = await shopify.resourcePicker({
      type: 'product',
      // Reopening with the current selection keeps the picker's checkboxes in
      // step with the form.
      selectionIds: products.map((product) => ({id: product.id})),
      multiple: 5,
    });

    // Canceling returns undefined rather than an empty array, and treating those the
    // same clears a selection the user meant to keep.
    if (!selection) return;

    // Keep both: a target filters on the numeric part of the GID, and the annotations
    // are written from the title.
    setProducts(
      selection.map((product) => ({id: product.id, title: product.title})),
    );
  }
  // [END campaign-dashboard.product-picker]

  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('products', JSON.stringify(products));
    // The choice list submits under its own name, so clear that before appending the
    // state the component tracks, or every channel arrives twice.
    form.delete('channels');
    for (const channel of channels) form.append('channels', channel);
    fetcher.submit(form, {method: 'post'});
  }

  return (
    <s-page heading="Campaigns">
      <s-section heading="Campaigns on record">
        {seedErrors.length > 0 && (
          <s-banner tone="critical" heading="The first campaign couldn't be saved">
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
          <s-stack direction="block" gap="small-200">
            {campaigns.map((campaign) => (
              <s-stack key={campaign.id} direction="inline" gap="base">
                <s-link href={`/app/campaigns/${campaign.id}`}>
                  {campaign.title}
                </s-link>
                <s-text tone="subdued">
                  {campaign.startDate} to {campaign.endDate}
                </s-text>
                <s-badge>{campaign.status}</s-badge>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>

      <form onSubmit={submit}>
        {/* [START campaign-dashboard.spawn-form] */}
        {/* The record this produces is what every query, target, and annotation on
            the campaign's page is derived from. */}
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
              label="Audience"
              name="audience"
              details="Written onto each customer at launch, and what the audience goal is measured against."
            >
              {AUDIENCE_TIERS.map((tier) => (
                <s-option key={tier.value} value={tier.value}>
                  {tier.label}
                </s-option>
              ))}
            </s-select>

            {/* Three goals, because lifting the store and selling the promoted
                products are different results. Each becomes a target at launch. */}
            <s-money-field
              label="Store-wide revenue goal"
              name="revenueTarget"
              placeholder="5000.00"
            />
            <s-money-field
              label="Promoted product goal"
              name="productTarget"
              placeholder="5000.00"
              details="Measured with a filter on the products below."
            />
            <s-money-field
              label="Audience goal"
              name="audienceTarget"
              placeholder="2500.00"
              details="Measured with a filter on the audience above."
            />

            <s-button variant="primary" type="submit" loading={creating}>
              Create campaign
            </s-button>
          </s-stack>
        </s-section>
        {/* [END campaign-dashboard.spawn-form] */}

        {/* [START campaign-dashboard.picker-render] */}
        <s-section heading="Promoted products">
          <s-paragraph>
            The products this campaign pushes. Their IDs filter the promoted
            product goal, and their titles name the product launch annotation.
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
        {/* What the campaign sends on decides which funnels the dashboard can draw.
            Each channel reports a different set of stages, so say which. */}
        <s-section heading="Channels">
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
                selected={channels.includes(key) || undefined}
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
    </s-page>
  );
}

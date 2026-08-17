import {promotedNames} from '../campaigns';
import {tierLabel} from '../audiences';

import {PanelHeader} from './shared';

// [START campaign-dashboard.target-bar]
// A share reads as a length before it reads as two amounts. App Home has no progress
// bar. This is two boxes instead: a track, and a fill sized to the percentage. Box
// backgrounds are `subdued`, `base`, or `strong`, which leaves tone to the badge.
function TargetCard({scope, percent, actual, by, expected, format, queryError, children}) {
  const met = percent !== null && percent >= 100;
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{scope}</s-text>
        <s-heading>{format(actual ?? 0)}</s-heading>
        <s-text color="subdued">
          of {format(expected)} by {by}
        </s-text>

        {/* Hidden from assistive tech. The badge below states the same percentage. */}
        <s-box
          background="base"
          borderRadius="large"
          blockSize="8px"
          overflow="hidden"
          accessibilityVisibility="hidden"
        >
          <s-box
            background="strong"
            borderRadius="large"
            blockSize="8px"
            inlineSize={`${Math.min(100, percent ?? 0)}%`}
          />
        </s-box>

        <s-stack direction="inline">
          <s-badge
            progress={met ? 'complete' : 'partiallyComplete'}
            tone={met ? 'success' : 'info'}
          >
            {percent === null ? 'Not measured' : `${percent}% of target`}
          </s-badge>
        </s-stack>

        {queryError && (
          <s-banner tone="warning">
            <s-paragraph>{queryError}</s-paragraph>
          </s-banner>
        )}

        {children}
      </s-stack>
    </s-box>
  );
}
// [END campaign-dashboard.target-bar]

// [START campaign-dashboard.target-copy]
// `filters` is ShopifyQL. Say what it narrows to, and fall back to the expression.
function targetScope(target, campaign, dimensions) {
  if (!target.filters) return 'Total sales';
  if (target.filters.startsWith('product_id')) {
    const names = promotedNames(campaign);
    return names ? `Sales of ${names}` : 'Sales of the promoted products';
  }
  if (target.filters.includes(dimensions.customer.key)) {
    return `Sales to ${tierLabel(campaign.audience).toLowerCase()}`;
  }
  return `Filtered by ${target.filters}`;
}
// [END campaign-dashboard.target-copy]

// [START campaign-dashboard.target-split]
// The unfiltered target is the number the campaign gets judged on.
export function splitTargets(targets) {
  return {
    storeTarget: targets.find((target) => !target.filters) ?? null,
    scopedTargets: targets.filter((target) => target.filters),
  };
}
// [END campaign-dashboard.target-split]

// [START campaign-dashboard.target-render]
// The store-wide target first, then the slices of it.
export function TargetsPanel({
  targets,
  storeTarget,
  scopedTargets,
  campaign,
  dimensions,
  pace,
  running,
  busy,
  submit,
  today,
  currency,
  shortDate,
}) {
  if (targets.length === 0) return null;

  return (
    <s-section>
      <PanelHeader
        title="Targets"
        uses={{
          targets:
            'Every target on this panel is a target on the store, created and measured by Shopify.',
          shopifyql:
            "Reads the store's actual sales for the window each target is measured against.",
        }}
      />
      <s-paragraph>
        Shopify measures each target against the store's own sales.
      </s-paragraph>

      {/* Drawn the same way as the whole, to be compared by looking. */}
      <s-grid gridTemplateColumns="repeat(2, 1fr)" gap="base">
        {storeTarget && (
          <TargetCard
            scope={targetScope(storeTarget, campaign, dimensions)}
            percent={storeTarget.percent}
            actual={storeTarget.actual}
            by={shortDate(campaign.endDate)}
            expected={storeTarget.expectedValue}
            format={currency}
            queryError={storeTarget.queryError}
          >
            {running && storeTarget.percent !== null && storeTarget.percent >= 100 && (
              <s-stack direction="inline" gap="base">
                <s-button
                  loading={busy}
                  onClick={() =>
                    submit('milestone', {targetId: storeTarget.id, day: today})
                  }
                >
                  Mark the day it was hit
                </s-button>
                <s-button
                  loading={busy}
                  onClick={() => submit('raise-target', {targetId: storeTarget.id})}
                >
                  Raise the target
                </s-button>
              </s-stack>
            )}
          </TargetCard>
        )}

        {scopedTargets.map((target) => (
          <TargetCard
            key={target.id}
            scope={targetScope(target, campaign, dimensions)}
            percent={target.percent}
            actual={target.actual}
            by={shortDate(campaign.endDate)}
            expected={target.expectedValue}
            format={currency}
            queryError={target.queryError}
          />
        ))}

        {/* What the target needs per day against what it's averaged. The percentage
            alone can't say whether it's behind. */}
        {pace && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small-300">
              <s-text color="subdued">Store-wide daily pace</s-text>
              <s-heading>{currency(pace.perDay)} a day</s-heading>
              <s-text color="subdued">
                {pace.left === 0
                  ? 'The window has closed.'
                  : `${currency(pace.needed)} a day over the ${pace.left} ${
                      pace.left === 1 ? 'day' : 'days'
                    } left hits the target.`}
              </s-text>
              <s-stack direction="inline">
                <s-badge
                  icon={pace.perDay >= pace.needed ? 'check-circle' : 'clock'}
                  tone={pace.perDay >= pace.needed ? 'success' : 'info'}
                >
                  {pace.left === 0
                    ? 'Window closed'
                    : pace.perDay >= pace.needed
                      ? 'On pace'
                      : 'Behind pace'}
                </s-badge>
              </s-stack>
            </s-stack>
          </s-box>
        )}
      </s-grid>
    </s-section>
  );
}
// [END campaign-dashboard.target-render]

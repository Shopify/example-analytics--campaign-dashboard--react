import {promotedNames, qrTitle} from '../campaigns';
import {tierLabel} from '../audiences';
import {exploreLink} from '../annotations';

import {ConfirmButton} from './confirm';
import {PanelHeader} from './shared';
import {useMetricCardsReady} from './sales';

// [START campaign-dashboard.target-chart]
// A running total from the target's first day, scoped by its filter. ANNOTATE ALL
// puts the store's annotations, this campaign's included, on the same axis.
// Product targets add daily bars under the line, so a strong day stands out.
export function targetChartQuery(target) {
  // QR targets measure a `campaign_sales` metric, which `sales` doesn't have.
  const from =
    target.shopifyqlQuery?.match(/^\s*FROM (\w+)/)?.[1] ??
    (target.metric.startsWith('campaign_') ? 'campaign_sales' : 'sales');
  const running = `${target.metric}__cumulative TYPE line`;
  const daily = target.filters?.startsWith('product_id') ? `${target.metric} TYPE bar, ` : '';
  return [
    `FROM ${from}`,
    `SHOW ${target.metric}`,
    target.filters ? `WHERE ${target.filters}` : null,
    'TIMESERIES day WITH CUMULATIVE_VALUES',
    `SINCE ${target.startDate} UNTIL ${target.endDate}`,
    'COMPARE TO TARGETS',
    `VISUALIZE ${daily}${running} ANNOTATE ALL`,
  ]
    .filter(Boolean)
    .join(' ');
}
// [END campaign-dashboard.target-chart]

// [START campaign-dashboard.target-bar]
function TargetCard({target, scope, by, format, cardReady}) {
  const {percent, actual, expectedValue, queryError} = target;
  const met = percent !== null && percent >= 100;
  const query = targetChartQuery(target);
  // A QR code's chart stays blank until an order arrives through its link.
  const noSales = !actual && target.filters?.startsWith('utm_campaign');
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">{scope}</s-text>
          <s-badge tone={met ? 'success' : 'info'}>
            {percent === null ? 'Not measured' : `${percent}%`}
          </s-badge>
        </s-stack>
        <s-text type="strong">
          {actual === null
            ? `Target ${format(expectedValue)} by ${by}`
            : `${format(actual)} of ${format(expectedValue)} by ${by}`}
        </s-text>

        {/* The card fills its container's height. */}
        <div style={{height: '200px'}}>
          {noSales ? (
            <s-paragraph color="subdued">
              No sales from this code yet. Sales appear here after customers check out through
              the code's link.
            </s-paragraph>
          ) : cardReady ? (
            <s-shopifyql-metric-card
              heading={scope}
              query={query}
              summary="none"
              reportLinkDisabled
            />
          ) : (
            <s-spinner accessibilityLabel="Loading the target chart" />
          )}
        </div>

        {queryError && (
          <s-banner tone="warning">
            <s-paragraph>{queryError}</s-paragraph>
          </s-banner>
        )}

        <s-link
          href={exploreLink(query)}
          target="_blank"
          accessibilityLabel={`Open ${scope} in Analytics`}
        >
          Open in Analytics
        </s-link>
      </s-stack>
    </s-box>
  );
}
// [END campaign-dashboard.target-bar]

// [START campaign-dashboard.target-copy]
function targetScope(target, campaign, dimensions) {
  if (!target.filters) return 'Total sales';
  if (target.filters.startsWith('product_id')) {
    const names = promotedNames(campaign);
    return names ? `Sales of ${names}` : 'Sales of the promoted products';
  }
  const qrHandle = target.filters.match(/^utm_campaign = '([a-z0-9_-]+)'$/)?.[1];
  if (qrHandle) return `Sales from the ${qrTitle(campaign, qrHandle)} QR code`;
  if (target.filters.includes(dimensions.customer.key)) {
    return `Sales to ${tierLabel(campaign.audience)} customers`;
  }
  return 'Filtered sales';
}
// [END campaign-dashboard.target-copy]

// [START campaign-dashboard.target-split]
export function splitTargets(targets) {
  return {
    storeTarget: targets.find((target) => !target.filters) ?? null,
    scopedTargets: targets.filter((target) => target.filters),
  };
}
// [END campaign-dashboard.target-split]

// [START campaign-dashboard.target-render]
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
  const cardReady = useMetricCardsReady();
  if (targets.length === 0) return null;
  // Once the window ends, the pace is the result.
  const onPace =
    pace &&
    (pace.left === 0 ? (storeTarget?.percent ?? 0) >= 100 : pace.perDay >= pace.needed);

  const card = (target) => (
    <TargetCard
      key={target.id}
      target={target}
      scope={targetScope(target, campaign, dimensions)}
      by={shortDate(target.endDate ?? campaign.endDate)}
      format={currency}
      cardReady={cardReady}
    />
  );

  return (
    <s-section>
      <PanelHeader
        title="Targets"
        uses={{
          targets:
            'Every target here is a record on the store, created by this app.',
          shopifyql:
            "Each chart runs its target's filter as a running total, with COMPARE TO TARGETS and ANNOTATE ALL.",
        }}
      />
      <s-paragraph>
        Each line is the running total since its target started, against the target.
        The chart marks the campaign's annotations, including the day each QR code
        went live.
      </s-paragraph>

      <s-stack direction="block" gap="base">
        {/* What the store target needs per day against what it's averaged. The
            percentage alone can't say whether it's behind. */}
        {storeTarget && pace && (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge
              icon={onPace ? 'check-circle' : 'clock'}
              tone={onPace ? 'success' : 'info'}
            >
              {pace.left === 0 ? 'Ended' : onPace ? 'On pace' : 'Behind pace'}
            </s-badge>
            <s-text color="subdued">
              {pace.left === 0
                ? `Averaged ${currency(pace.perDay)} a day.`
                : `Averaging ${currency(pace.perDay)} a day. The store target needs ${currency(
                    pace.needed,
                  )} a day for the ${pace.left} ${pace.left === 1 ? 'day' : 'days'} left.`}
            </s-text>
          </s-stack>
        )}
        {running && storeTarget?.percent !== null && storeTarget?.percent >= 100 && (
          <s-stack direction="inline" gap="base">
            <s-button
              loading={busy === 'milestone'}
              disabled={Boolean(busy)}
              onClick={() => submit('milestone', {targetId: storeTarget.id, day: today})}
            >
              Mark milestone
            </s-button>
            <ConfirmButton
              id="raise-target"
              label="Raise target"
              heading="Raise the store target?"
              body="The store target moves to the next round amount above sales so far. You can't lower it again from the app."
              confirmLabel="Raise target"
              loading={busy === 'raise-target'}
              disabled={Boolean(busy)}
              onConfirm={() => submit('raise-target', {targetId: storeTarget.id})}
            />
          </s-stack>
        )}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap="base">
          {storeTarget && card(storeTarget)}
          {scopedTargets.map(card)}
        </s-grid>
      </s-stack>
    </s-section>
  );
}
// [END campaign-dashboard.target-render]

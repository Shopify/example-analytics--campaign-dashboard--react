import {promotedNames, qrTitle} from '../campaigns';
import {tierLabel} from '../audiences';
import {exploreLink} from '../annotations';

import {PanelHeader} from './shared';
import {useMetricCardsReady} from './sales';

// [START campaign-dashboard.target-chart]
// A running total from the target's first day, scoped by its filter. ANNOTATE ALL
// puts the store's annotations, this campaign's included, on the same axis.
export function targetChartQuery(target) {
  // QR targets measure a `campaign_sales` metric, which `sales` doesn't have.
  const from =
    target.shopifyqlQuery?.match(/^\s*FROM (\w+)/)?.[1] ??
    (target.metric.startsWith('campaign_') ? 'campaign_sales' : 'sales');
  return [
    `FROM ${from}`,
    `SHOW ${target.metric}`,
    target.filters ? `WHERE ${target.filters}` : null,
    'TIMESERIES day WITH CUMULATIVE_VALUES',
    `SINCE ${target.startDate} UNTIL ${target.endDate}`,
    'COMPARE TO TARGETS',
    `VISUALIZE ${target.metric}__cumulative TYPE line ANNOTATE ALL`,
  ]
    .filter(Boolean)
    .join(' ');
}
// [END campaign-dashboard.target-chart]

// [START campaign-dashboard.target-bar]
function TargetCard({target, scope, by, format, cardReady, children}) {
  const {percent, actual, expectedValue, queryError} = target;
  const met = percent !== null && percent >= 100;
  const query = targetChartQuery(target);
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-stack direction="block" gap="small-300">
            <s-text color="subdued">{scope}</s-text>
            <s-heading>
              {actual === null
                ? `Target ${format(expectedValue)} by ${by}`
                : `${format(actual)} of ${format(expectedValue)} by ${by}`}
            </s-heading>
          </s-stack>
          <s-badge tone={met ? 'success' : 'info'}>
            {percent === null ? 'Not measured' : `${percent}% of target`}
          </s-badge>
        </s-stack>

        {/* The card fills its container's height. */}
        <div style={{height: '260px'}}>
          {cardReady ? (
            <s-shopifyql-metric-card heading={`${scope} to date`} query={query} />
          ) : (
            <s-spinner accessibilityLabel="Loading the target chart" />
          )}
        </div>

        {queryError && (
          <s-banner tone="warning">
            <s-paragraph>{queryError}</s-paragraph>
          </s-banner>
        )}

        {children}

        <s-stack direction="inline">
          <s-link
            href={exploreLink(query)}
            target="_blank"
            accessibilityLabel={`Open ${scope} in Analytics`}
          >
            Open in Analytics
          </s-link>
        </s-stack>
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

  const card = (target, children) => (
    <TargetCard
      key={target.id}
      target={target}
      scope={targetScope(target, campaign, dimensions)}
      by={shortDate(target.endDate ?? campaign.endDate)}
      format={currency}
      cardReady={cardReady}
    >
      {children}
    </TargetCard>
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
        Each line is the running total since its target started. The chart marks the
        campaign's annotations, including the day each QR code went live.
      </s-paragraph>

      <s-stack direction="block" gap="base">
        {storeTarget &&
          card(
            storeTarget,
            <s-stack direction="block" gap="small-300">
              {/* What the target needs per day against what it's averaged. The
                  percentage alone can't say whether it's behind. */}
              {pace && (
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
                      : `Averaging ${currency(pace.perDay)} a day. The target needs ${currency(
                          pace.needed,
                        )} a day for the ${pace.left} ${pace.left === 1 ? 'day' : 'days'} left.`}
                  </s-text>
                </s-stack>
              )}
              {running && storeTarget.percent !== null && storeTarget.percent >= 100 && (
                <s-stack direction="inline" gap="base">
                  <s-button
                    loading={busy}
                    onClick={() =>
                      submit('milestone', {targetId: storeTarget.id, day: today})
                    }
                  >
                    Mark milestone
                  </s-button>
                  <s-button
                    loading={busy}
                    onClick={() => submit('raise-target', {targetId: storeTarget.id})}
                  >
                    Raise target
                  </s-button>
                </s-stack>
              )}
            </s-stack>,
          )}

        {scopedTargets.map((target) => card(target, null))}
      </s-stack>
    </s-section>
  );
}
// [END campaign-dashboard.target-render]

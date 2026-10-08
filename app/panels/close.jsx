import {useEffect} from 'react';
import {useRevalidator} from 'react-router';
// [START campaign-dashboard.close-render]
import {ConfirmButton} from './confirm';

// The writes that end a campaign sit after the evidence they act on.
export function CampaignLifecycle({
  campaign,
  openCampaign,
  closesOn,
  running,
  busy,
  submit,
  shortDate,
  stampsOrders,
  children,
}) {
  // A closed campaign has no controls left. A planned one shows Cancel beside Activate
  // at the top of the page.
  if (campaign.status === 'closed' || campaign.status === 'planned') return null;

  return (
    <s-section heading="Campaign actions">
      <s-box paddingBlockStart="base" />
      <s-stack direction="block" gap="base">
        {openCampaign && (
          <s-paragraph>
            Closing ends the <s-text>{openCampaign.title}</s-text> annotation on{' '}
            {shortDate(closesOn)}. The annotation title then shows the campaign
            result.{' '}
            {stampsOrders
              ? 'Each order placed after a campaign touch gets a metafield with the last touch before the order. Order attribution fills in after you close.'
              : 'Closing records no order attribution. Make the order dimension queryable before you close to record it.'}
          </s-paragraph>
        )}
        {campaign.status === 'canceled' && (
          <s-paragraph>
            Canceled. The app removed this campaign's annotations and targets.
          </s-paragraph>
        )}
        <s-stack direction="inline" gap="base">
          {running && (
            <ConfirmButton
              id="close-campaign"
              variant="primary"
              label="Close campaign"
              heading="Close this campaign?"
              body={
                stampsOrders
                  ? `The campaign ends on ${shortDate(closesOn)} and records each order's last campaign touch. You can't reopen it.`
                  : `The campaign ends on ${shortDate(closesOn)}. You can't reopen it.`
              }
              confirmLabel="Close campaign"
              loading={busy === 'close'}
              disabled={Boolean(busy)}
              onConfirm={() => submit('close')}
            />
          )}
          {campaign.status === 'canceled' && (
            <s-button
              variant="primary"
              loading={busy === 'replan'}
              disabled={Boolean(busy)}
              onClick={() => submit('replan')}
            >
              Replan campaign
            </s-button>
          )}
          {running && (
            <ConfirmButton
              id="cancel-running"
              tone="critical"
              label="Cancel campaign"
              heading="Cancel this campaign?"
              body="Canceling removes this campaign's annotations and targets from Shopify Analytics."
              confirmLabel="Cancel campaign"
              loading={busy === 'cancel'}
              disabled={Boolean(busy)}
              onConfirm={() => submit('cancel')}
            />
          )}
          {children}
        </s-stack>
      </s-stack>
    </s-section>
  );
}
// [END campaign-dashboard.close-render]

// [START campaign-dashboard.stamp-status-render]
// Stamping runs after the close returns. Reload while it runs, and offer a retry if it fails.
const STAMP_POLL_MS = 5000;

export function OrderStamping({stamping, busy, submit}) {
  const revalidator = useRevalidator();
  const running = stamping?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      if (revalidator.state === 'idle') revalidator.revalidate();
    }, STAMP_POLL_MS);
    return () => clearInterval(timer);
  }, [running, revalidator]);

  if (!stamping) return null;
  const problems = stamping.problems.map((problem) => problem.message).join(' ');

  return (
    <s-section heading="Order attribution">
      {running && (
        <s-banner tone="info" heading="Stamping orders">
          <s-paragraph>
            Shopify is writing each order's last campaign touch. {stamping.objectCount} done so
            far. This page updates when it finishes.
          </s-paragraph>
        </s-banner>
      )}
      {stamping.state === 'done' && (
        <s-banner tone="success" heading="Orders stamped">
          <s-paragraph>Order attribution covers this campaign's orders.</s-paragraph>
        </s-banner>
      )}
      {stamping.state === 'unread' && (
        <s-banner tone="warning" heading="Couldn't check order stamping">
          <s-paragraph>Reload the page to try again. The store returned: {problems}</s-paragraph>
        </s-banner>
      )}
      {stamping.state === 'failed' && (
        <s-banner tone="critical" heading="Some orders weren't stamped">
          <s-paragraph>{problems}</s-paragraph>
          <s-button
            slot="secondary-actions"
            loading={busy === 'stamp-orders'}
            disabled={Boolean(busy)}
            onClick={() => submit('stamp-orders')}
          >
            Stamp orders again
          </s-button>
        </s-banner>
      )}
    </s-section>
  );
}
// [END campaign-dashboard.stamp-status-render]

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
  children,
}) {
  // A closed campaign gates out every control below. A planned one offers
  // Cancel beside Activate at the top of the page instead of a section here.
  if (campaign.status === 'closed' || campaign.status === 'planned') return null;

  return (
    <s-section heading="Campaign actions">
      <div style={{height: '12px'}} />
      <s-stack direction="block" gap="base">
        {openCampaign && (
          <s-paragraph>
            Closing ends the <s-text>{openCampaign.title}</s-text> annotation on{' '}
            {shortDate(closesOn)}. The annotation title then shows the campaign
            result. If the order dimension exists, each order placed after a
            campaign touch gets a metafield with the last touch before the
            order. Order attribution fills in after you close.
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
              body={`The campaign ends on ${shortDate(closesOn)} and records each order's last campaign touch. You can't reopen it.`}
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

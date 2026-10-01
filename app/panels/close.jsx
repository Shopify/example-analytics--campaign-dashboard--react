// [START campaign-dashboard.close-render]
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
            result. Each order gets a metafield with the last campaign touch
            before the order. Order attribution fills in after you close.
          </s-paragraph>
        )}
        {campaign.status === 'canceled' && (
          <s-paragraph>
            Canceled. The app removed this campaign's annotations and targets.
          </s-paragraph>
        )}
        <s-stack direction="inline" gap="base">
          {running && (
            <s-button variant="primary" loading={busy} onClick={() => submit('close')}>
              Close campaign
            </s-button>
          )}
          {campaign.status === 'canceled' && (
            <s-button variant="primary" loading={busy} onClick={() => submit('replan')}>
              Replan campaign
            </s-button>
          )}
          {running && (
            <s-button tone="critical" loading={busy} onClick={() => submit('cancel')}>
              Cancel campaign
            </s-button>
          )}
          {children}
        </s-stack>
      </s-stack>
    </s-section>
  );
}
// [END campaign-dashboard.close-render]

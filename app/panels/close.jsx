// [START campaign-dashboard.close-render]
// Closing rewrites the campaign's own annotation rather than adding a second. The
// writes that end a campaign sit after the evidence they act on.
export function CampaignLifecycle({
  campaign,
  openCampaign,
  closesOn,
  running,
  busy,
  submit,
  shortDate,
}) {
  return (
    <s-section heading="Campaign lifecycle">
      <s-stack direction="block" gap="base">
        {openCampaign && (
          <s-paragraph>
            <s-text>{openCampaign.title}</s-text> sits on the store's charts as a
            span with no end. Closing it ends the span on {shortDate(closesOn)},
            rewrites the title with what the campaign earned, and stamps each
            order with the last send that reached the customer before it. Until
            then, Order attribution has nothing to group.
          </s-paragraph>
        )}
        <s-stack direction="inline" gap="base">
          {running && (
            <s-button variant="primary" loading={busy} onClick={() => submit('close')}>
              Close the campaign with its result
            </s-button>
          )}
          {campaign.status === 'canceled' ? (
            <s-button variant="primary" loading={busy} onClick={() => submit('replan')}>
              Plan the campaign again
            </s-button>
          ) : (
            <s-button tone="critical" loading={busy} onClick={() => submit('cancel')}>
              Cancel the campaign
            </s-button>
          )}
        </s-stack>
      </s-stack>
    </s-section>
  );
}
// [END campaign-dashboard.close-render]

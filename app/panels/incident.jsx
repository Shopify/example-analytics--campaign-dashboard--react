// [START campaign-dashboard.incident-banner]
export function IncidentBanner({
  health,
  bounced,
  bounceReasons,
  incidentFlagged,
  total,
  integer,
  busy,
  submit,
  today,
  canFlag,
}) {
  if (bounced === 0) return null;

  return (
    <s-section>
      <s-banner
        tone="info"
        heading={`${health.bounceRate.toFixed(1)}% email bounce rate`}
      >
        <s-paragraph>
          {integer(bounced)} of {integer(total('emails_sent'))} emails bounced
          {bounceReasons.length > 0 ? `. Top reason: ${bounceReasons[0].reason}` : ''}.
        </s-paragraph>
        {incidentFlagged ? (
          <s-box paddingBlockStart="base">
            <s-text color="subdued">Incident flagged.</s-text>
          </s-box>
        ) : canFlag && (
          <>
            <s-paragraph>
              Flag the incident to annotate the store’s sales charts.
            </s-paragraph>
            <s-box paddingBlockStart="base">
              <s-button
                loading={busy === 'flag-incident'}
                disabled={Boolean(busy)}
                onClick={() => submit('flag-incident', {day: today})}
              >
                Flag incident
              </s-button>
            </s-box>
          </>
        )}
      </s-banner>
    </s-section>
  );
}
// [END campaign-dashboard.incident-banner]

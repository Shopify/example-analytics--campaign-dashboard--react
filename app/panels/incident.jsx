// [START campaign-dashboard.incident-banner]
// A bounce reaches someone who never opens this app once it's on the store's charts.
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
}) {
  if (bounced === 0) return null;

  return (
    <s-section>
      <s-banner
        tone="info"
        heading={`${health.bounceRate.toFixed(1)}% of this campaign's emails bounced`}
      >
        <s-paragraph>
          {integer(bounced)} of {integer(total('emails_sent'))} emails didn't arrive
          {bounceReasons.length > 0 ? `, mostly ${bounceReasons[0].reason}` : ''}.
        </s-paragraph>
        <s-paragraph>
          Marking it dates the failed send on the store's sales charts, where whoever
          reviews this week's numbers reads it without opening this app.
        </s-paragraph>
        <s-box paddingBlockStart="base">
          {incidentFlagged ? (
            <s-text color="subdued">Already marked on the store's charts.</s-text>
          ) : (
            <s-button
              loading={busy}
              onClick={() => submit('flag-incident', {day: today})}
            >
              Mark the bounce on the store's charts
            </s-button>
          )}
        </s-box>
      </s-banner>
    </s-section>
  );
}
// [END campaign-dashboard.incident-banner]

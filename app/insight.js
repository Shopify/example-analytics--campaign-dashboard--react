// [START campaign-dashboard.insight-window]
// Lead-in weeks, without which a product already climbing before launch looks
// identical to one the campaign lifted.
const LEAD_IN_WEEKS = 3;

// UNTIL runs to today rather than to the last Sunday, or a campaign that launched
// this week has every marker it wrote sitting past the last point on the chart.

export function insightWindow(campaign) {
  const start = new Date(`${campaign.startDate}T00:00:00`);
  const days = Math.max(0, (Date.now() - start.getTime()) / 86400000);
  const weeks = Math.ceil(days / 7) + LEAD_IN_WEEKS;
  return `SINCE startOfWeek(-${weeks}w) UNTIL today`;
}
// [END campaign-dashboard.insight-window]

// [START campaign-dashboard.insight]
// The longest unbroken run in either direction, which is the one sentence worth
// leading the page with.
export function findInsight(weekly) {
  const byProduct = new Map();
  for (const row of weekly.tableData.rows) {
    const title = row['product_title'];
    if (!title) continue;
    if (!byProduct.has(title)) byProduct.set(title, new Map());
    byProduct.get(title).set(row['week'], Number(row['gross_sales'] ?? 0));
  }

  // Stepping 7 days rather than reading the weeks off the rows. TIMESERIES returns
  // no row for a week where nothing sold, and OVERALL is what makes that missing
  // row safe to read as a zero.
  const present = [
    ...new Set(weekly.tableData.rows.map((row) => row['week'])),
  ].sort();
  if (present.length < 2) return null;

  const weeks = [];
  for (
    let week = new Date(`${present[0]}T00:00:00Z`);
    week <= new Date(`${present.at(-1)}T00:00:00Z`);
    week.setUTCDate(week.getUTCDate() + 7)
  ) {
    weeks.push(week.toISOString().slice(0, 10));
  }

  // UNTIL today ends mid-week, and a three-day bucket dips next to a full one and
  // reads as a collapse, so rank on the weeks that have finished.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const settled = weeks.filter((week) => week <= cutoff);
  if (settled.length < 2) return null;

  let best = null;
  for (const [title, sales] of byProduct) {
    const series = settled.map((week) => sales.get(week) ?? 0);
    const last = series.length - 1;

    // A "3rd week up" needs three rising weeks, not three rows.
    const rising = series[last] > series[last - 1];
    if (series[last] === series[last - 1]) continue;

    let streak = 1;
    while (
      streak < series.length &&
      (rising
        ? series[last - streak + 1] > series[last - streak]
        : series[last - streak + 1] < series[last - streak])
    ) {
      streak += 1;
    }

    const latest = series[last];
    const first = series[last - streak + 1];
    const growth =
      first > 0 ? Math.round(((latest - first) / first) * 100) : null;

    // Run length first, then money moved, so a long run beats a one-week jump.
    const swing = Math.abs(latest - first);
    if (
      !best ||
      streak > best.streak ||
      (streak === best.streak && swing > best.swing)
    ) {
      best = {
        title,
        streak,
        rising,
        latest,
        first,
        growth,
        swing,
        // Every week, including the short one, so this week's markers have a
        // point to sit on.
        series: weeks.map((week) => sales.get(week) ?? 0),
        weeks,
        settledWeek: settled.at(-1),
      };
    }
  }
  return best;
}

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th'];
export const ordinal = (n) => ORDINALS[n] ?? `${n}th`;
// [END campaign-dashboard.insight]

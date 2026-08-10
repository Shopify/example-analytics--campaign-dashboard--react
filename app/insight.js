// [START campaign-dashboard.insight-window]
// The campaign's own weeks plus three weeks of lead-in. Without the lead-in, a
// product already climbing before launch looks identical to one the campaign
// lifted.
//
// UNTIL runs to today rather than to the last Sunday. A campaign that launched
// this week would otherwise have every marker it wrote sitting past the last
// point on the chart.
const LEAD_IN_WEEKS = 3;

export function insightWindow(campaign) {
  const start = new Date(`${campaign.startDate}T00:00:00`);
  const days = Math.max(0, (Date.now() - start.getTime()) / 86400000);
  const weeks = Math.ceil(days / 7) + LEAD_IN_WEEKS;
  return `SINCE startOfWeek(-${weeks}w) UNTIL today`;
}
// [END campaign-dashboard.insight-window]

// [START campaign-dashboard.insight]
// Turn the weekly rows into the one sentence worth leading with. A product on a
// multi-week run is the thing a user wants to know the moment they open the app,
// and the annotations in the same window are the answer to why.
export function findInsight(weekly) {
  const byProduct = new Map();
  for (const row of weekly.tableData.rows) {
    const title = row['product_title'];
    if (!title) continue;
    if (!byProduct.has(title)) byProduct.set(title, new Map());
    byProduct.get(title).set(row['week'], Number(row['gross_sales'] ?? 0));
  }

  // Build the axis by stepping 7 days rather than from the weeks the rows
  // mention. TIMESERIES returns no row for a week where nothing sold, so a quiet
  // week disappears and two non-adjacent weeks get compared as though they
  // weren't. OVERALL is what makes a missing row safe to read as a zero.
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

  // UNTIL today ends mid-week, so the last bucket is short. Rank on the weeks
  // that have finished, because a three-day bucket always dips next to a full
  // one and reads as a collapse.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const settled = weeks.filter((week) => week <= cutoff);
  if (settled.length < 2) return null;

  let best = null;
  for (const [title, sales] of byProduct) {
    const series = settled.map((week) => sales.get(week) ?? 0);
    const last = series.length - 1;

    // Count back from the most recent finished week for as long as the direction
    // holds. A "3rd week up" needs three rising weeks, not three rows. A run
    // down is worth surfacing too, because that's the one the user has to act
    // on.
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

    // Rank by the length of the run, then by how much money moved, so a long run
    // beats a big one-week jump and a $4,000 swing beats a $40 one.
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
        // The chart draws every week in the window, including the short one, so
        // the markers the campaign wrote this week still have a point to sit on.
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

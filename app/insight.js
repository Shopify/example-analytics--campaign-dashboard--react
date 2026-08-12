// [START campaign-dashboard.insight-window]
// Sales before launch, to tell a lifted product from one already climbing.
const LEAD_IN_WEEKS = 3;

// Lead-in weeks, then the campaign so far.
export function insightWindow(campaign) {
  const start = new Date(`${campaign.startDate}T00:00:00`);
  const days = Math.max(0, (Date.now() - start.getTime()) / 86400000);
  const weeks = Math.ceil(days / 7) + LEAD_IN_WEEKS;
  // Running past a closed campaign ranks the weeks after it against those inside it.
  const ended = new Date(`${campaign.endDate}T00:00:00`).getTime() < Date.now();
  return `SINCE startOfWeek(-${weeks}w) UNTIL ${ended ? campaign.endDate : 'today'}`;
}
// [END campaign-dashboard.insight-window]

// The store's best seller going in, before and during. Ranking on the lead-in weeks
// stops the campaign picking its own subject.
export function findInsight(weekly, campaign) {
  const byProduct = new Map();
  for (const row of weekly.tableData.rows) {
    const title = row['product_title'];
    if (!title) continue;
    if (!byProduct.has(title)) byProduct.set(title, new Map());
    byProduct.get(title).set(row['week'], Number(row['gross_sales'] ?? 0));
  }

  // TIMESERIES returns no row for a week with no sales. Step 7 days to fill the gaps.
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

  // A part-week bucket beside a full one reads as a collapse. Finished weeks only.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const settled = weeks.filter((week) => week <= cutoff);
  if (settled.length < 2 || campaign.startDate > settled.at(-1)) return null;

  const launchWeek = settled.findLast((week) => week <= campaign.startDate);
  const before = settled.filter((week) => week < launchWeek);
  const during = settled.filter((week) => week >= launchWeek);
  if (before.length === 0) return null;

  const mean = (sales, range) =>
    range.reduce((total, week) => total + (sales.get(week) ?? 0), 0) /
    range.length;

  let best = null;
  for (const [title, sales] of byProduct) {
    // A zero lead-in divides into infinite growth.
    const leadIn = mean(sales, before);
    const after = mean(sales, during);
    if (leadIn <= 0 || after <= 0) continue;
    if (!best || leadIn > best.leadIn) {
      best = {
        title,
        leadIn,
        during: after,
        series: settled.map((week) => sales.get(week) ?? 0),
        weeks: settled,
        leadInWeeks: before.length,
        campaignWeeks: during.length,
      };
    }
  }
  if (!best) return null;

  best.growth = Math.round(((best.during - best.leadIn) / best.leadIn) * 100);
  best.rising = best.growth > 0;
  return best;
}

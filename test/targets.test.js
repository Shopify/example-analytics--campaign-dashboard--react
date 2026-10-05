import {describe, expect, it} from 'vitest';
import {readTargets, targetNodes} from '../app/campaign-queries.server';
import {targetChartQuery} from '../app/panels/targets.jsx';
import {mockAdmin} from './helpers/admin';

describe('target charts', () => {
  const target = (overrides) => ({
    metric: 'total_sales',
    filters: null,
    startDate: '2026-09-10',
    endDate: '2026-10-07',
    shopifyqlQuery: 'FROM sales SHOW total_sales SINCE 2026-09-10 UNTIL 2026-10-07 VISUALIZE total_sales TYPE target_gauge',
    ...overrides,
  });

  it('draws the store target as daily bars under a running total, with targets and annotations', () => {
    expect(targetChartQuery(target())).toBe(
      'FROM sales SHOW total_sales TIMESERIES day WITH CUMULATIVE_VALUES SINCE 2026-09-10 UNTIL 2026-10-07 COMPARE TO TARGETS VISUALIZE total_sales TYPE bar, total_sales__cumulative TYPE line ANNOTATE ALL',
    );
  });

  it("keeps a QR target's table, filter, and live day", () => {
    const query = targetChartQuery(
      target({
        metric: 'campaign_last_non_direct_click_total_sales',
        filters: "utm_campaign = 'hat-front'",
        startDate: '2026-09-25',
        shopifyqlQuery: "FROM campaign_sales SHOW campaign_last_non_direct_click_total_sales WHERE utm_campaign = 'hat-front' SINCE 2026-09-25 UNTIL 2026-10-07 VISUALIZE campaign_last_non_direct_click_total_sales TYPE target_gauge",
      }),
    );
    expect(query).toBe(
      "FROM campaign_sales SHOW campaign_last_non_direct_click_total_sales WHERE utm_campaign = 'hat-front' TIMESERIES day WITH CUMULATIVE_VALUES SINCE 2026-09-25 UNTIL 2026-10-07 COMPARE TO TARGETS VISUALIZE campaign_last_non_direct_click_total_sales TYPE bar, campaign_last_non_direct_click_total_sales__cumulative TYPE line ANNOTATE ALL",
    );
  });

  it('keeps a product target\'s filter', () => {
    expect(targetChartQuery(target({filters: 'product_id IN (1, 2)'}))).toBe(
      'FROM sales SHOW total_sales WHERE product_id IN (1, 2) TIMESERIES day WITH CUMULATIVE_VALUES SINCE 2026-09-10 UNTIL 2026-10-07 COMPARE TO TARGETS VISUALIZE total_sales TYPE bar, total_sales__cumulative TYPE line ANNOTATE ALL',
    );
  });

  it('falls back to the table that holds the metric', () => {
    expect(
      targetChartQuery(
        target({metric: 'campaign_last_non_direct_click_total_sales', shopifyqlQuery: null}),
      ),
    ).toMatch(/^FROM campaign_sales /);
    expect(targetChartQuery(target({shopifyqlQuery: null}))).toMatch(/^FROM sales /);
  });
});

describe('target reads', () => {
  it('reads recorded targets by ID, including one that starts after the campaign', async () => {
    const late = {id: 'gid://shopify/AnalyticsTarget/2', startDate: '2026-09-25'};
    const {admin, calls} = mockAdmin({CampaignTargets: () => ({data: {targets: [null, late]}})});
    const body = await readTargets(admin, {
      startDate: '2026-09-10',
      targets: {store: 'gid://shopify/AnalyticsTarget/1', 'qr:hat-back': late.id, junk: 7},
    });
    expect(calls[0].variables.ids).toEqual(['gid://shopify/AnalyticsTarget/1', late.id]);
    expect(targetNodes(body)).toEqual([late]);
  });
});

import {describe, expect, it} from 'vitest';
import {orderDaysQuery, readAllTargets, targetNodes} from '../app/campaign-queries.server';
import {mockAdmin} from './helpers/admin';

describe('orderDaysQuery', () => {
  it('dates each order by its original sale, not a refund or an edit', () => {
    const query = orderDaysQuery({startDate: '2026-09-10', endDate: '2026-10-07'}, 0);
    expect(query).toContain(
      'WHERE excludes_post_order_adjustments = true AND is_sales_reversal = false AND is_sale_adjustment = false GROUP BY order_id, day',
    );
  });
});

describe('readAllTargets', () => {
  const gid = (index) => `gid://shopify/AnalyticsTarget/${index}`;

  it('reads each recorded ID once, at most 250 per read', async () => {
    const campaigns = [
      {id: 1, targets: Object.fromEntries(Array.from({length: 200}, (_unused, index) => [`qr:${index}`, gid(index)]))},
      {id: 2, targets: Object.fromEntries(Array.from({length: 60}, (_unused, index) => [`qr:${index}`, gid(index + 190)]))},
    ];
    const {admin, calls} = mockAdmin({CampaignTargets: ({ids}) => ({data: {targets: ids.map((id) => ({id}))}})});
    const body = await readAllTargets(admin, campaigns);

    expect(calls.map((call) => call.variables.ids.length)).toEqual([250]);
    expect(targetNodes(body)).toHaveLength(250);

    campaigns[1].targets.extra = gid(999);
    const {admin: larger, calls: largerCalls} = mockAdmin({CampaignTargets: ({ids}) => ({data: {targets: ids.map((id) => ({id}))}})});
    const merged = await readAllTargets(larger, campaigns);
    expect(largerCalls.map((call) => call.variables.ids.length)).toEqual([250, 1]);
    expect(targetNodes(merged).map((node) => node.id)).toEqual([...new Set(campaigns.flatMap((campaign) => Object.values(campaign.targets)))]);
    expect(merged.errors).toBeUndefined();
  });

  it("keeps the nodes that loaded and returns a failed read's errors", async () => {
    const campaigns = [{id: 1, targets: Object.fromEntries(Array.from({length: 251}, (_unused, index) => [`qr:${index}`, gid(index)]))}];
    const {admin} = mockAdmin({
      CampaignTargets: ({ids}) => (ids.length === 1 ? {errors: [{message: 'Throttled'}]} : {data: {targets: ids.map((id) => ({id}))}}),
    });
    const body = await readAllTargets(admin, campaigns);
    expect(targetNodes(body)).toHaveLength(250);
    expect(body.errors).toEqual([{message: 'Throttled'}]);
  });
});

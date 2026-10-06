import {describe, expect, it} from 'vitest';
import {orderDaysQuery} from '../app/campaign-queries.server';

describe('orderDaysQuery', () => {
  it('dates each order by its original sale, not a refund or an edit', () => {
    const query = orderDaysQuery({startDate: '2026-09-10', endDate: '2026-10-07'}, 0);
    expect(query).toContain(
      'WHERE is_sales_reversal = false AND is_sale_adjustment = false GROUP BY order_id, day',
    );
  });
});

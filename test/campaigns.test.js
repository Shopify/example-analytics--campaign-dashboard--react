import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  campaignMarks,
  campaignWindow,
  clamp,
  codeFilter,
  creatorTouches,
  isCalendarDate,
  isPositiveAmount,
  lastTouch,
  metafieldDimension,
  parseCreatorCodes,
  parseProducts,
  promotedFilter,
  recentWindow,
  sanitizeCode,
  shopMorning,
  targetEnd,
  touchMarks,
  withinWindow,
} from '../app/campaigns';

const campaign = (overrides = {}) => ({
  id: 4210,
  title: 'Summer launch',
  startDate: '2026-09-10',
  endDate: '2026-10-07',
  channels: ['email', 'sms', 'push'],
  products: [{id: 'gid://shopify/Product/1', title: 'Board'}],
  audience: 'vip',
  creators: [],
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('input checks', () => {
  it('accepts only positive finite amounts', () => {
    expect(isPositiveAmount('10.50')).toBe(true);
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('abc')).toBe(false);
    expect(isPositiveAmount('')).toBe(false);
    expect(isPositiveAmount('-4')).toBe(false);
  });

  it('accepts only real calendar days', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-2-3')).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });

  it('parses the product selection', () => {
    expect(parseProducts('not json')).toBeNull();
    expect(parseProducts('{}')).toBeNull();
    expect(parseProducts('')).toBeNull();
    expect(parseProducts(undefined)).toEqual([]);
    const many = Array.from({length: 7}, (_, i) => ({
      id: `gid://shopify/Product/${i + 1}`,
      title: ` P${i} `,
    }));
    const parsed = parseProducts(
      JSON.stringify([...many, {id: 'gid://shopify/Order/1', title: 'x'}, null]),
    );
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toEqual({id: 'gid://shopify/Product/1', title: 'P0'});
  });

  it('builds the promoted-product filter from digits only', () => {
    expect(promotedFilter(campaign({products: []}))).toBeNull();
    expect(
      promotedFilter(
        campaign({
          products: [
            {id: 'gid://shopify/Product/11'},
            {id: "gid://shopify/Product/1'); DROP"},
          ],
        }),
      ),
    ).toBe('product_id IN (11)');
  });
});

describe('windows', () => {
  it('uses the today token for a running campaign', () => {
    expect(campaignWindow(campaign())).toBe('SINCE 2026-09-10 UNTIL today');
  });

  it('uses the end date once the campaign ends or before it starts', () => {
    expect(campaignWindow(campaign({endDate: '2026-09-20'}))).toBe(
      'SINCE 2026-09-10 UNTIL 2026-09-20',
    );
    expect(
      campaignWindow(campaign({startDate: '2026-10-05', endDate: '2026-10-20'})),
    ).toBe('SINCE 2026-10-05 UNTIL 2026-10-20');
  });

  it('clamps the event window to the retained days', () => {
    expect(recentWindow(campaign({startDate: '2026-08-01'}))).toBe(
      'SINCE -29d UNTIL today',
    );
    expect(
      recentWindow(campaign({startDate: '2026-07-01', endDate: '2026-07-20'})),
    ).toBe('SINCE -29d UNTIL -29d');
  });

  it('treats a start one day inside the retention floor as expired', () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    expect(recentWindow(campaign({startDate: '2026-09-01', endDate: '2026-09-20'}))).toBe(
      'SINCE -29d UNTIL 2026-09-20',
    );
    expect(recentWindow(campaign({startDate: '2026-09-02', endDate: '2026-09-20'}))).toBe(
      'SINCE 2026-09-02 UNTIL 2026-09-20',
    );
    vi.useRealTimers();
  });

  it('ends a target after the day it starts', () => {
    expect(targetEnd('2026-09-10', '2026-10-07')).toBe('2026-10-07');
    expect(targetEnd('2026-09-30', '2026-09-30')).toBe('2026-10-01');
    expect(targetEnd('2026-10-03', '2026-09-30')).toBe('2026-10-04');
  });

  it('resolves a date to 9am in the shop timezone', () => {
    expect(new Date(shopMorning('2026-09-30', 'UTC')).toISOString()).toBe(
      '2026-09-30T09:00:00.000Z',
    );
    expect(
      new Date(shopMorning('2026-09-30', 'America/Los_Angeles')).toISOString(),
    ).toBe('2026-09-30T16:00:00.000Z');
    expect(new Date(shopMorning('2026-09-30', 'Asia/Tokyo')).toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
  });

  it('clamps offsets to the end date', () => {
    expect(withinWindow(campaign(), 5)).toBe('2026-09-15');
    expect(withinWindow(campaign({endDate: '2026-09-12'}), 5)).toBe('2026-09-12');
  });
});

describe('campaignMarks', () => {
  it('writes the span, the base marks, and one mark per send', () => {
    const marks = campaignMarks(campaign());
    expect(marks.map((mark) => mark.key)).toEqual([
      'campaign',
      'launch',
      'vip',
      'promo',
      'email',
      'sms',
      'push',
    ]);
    expect(marks.filter((mark) => mark.ranged)).toHaveLength(1);
  });

  it('skips the launch and offer without products and early access without a tier', () => {
    const marks = campaignMarks(campaign({products: [], audience: 'everyone'}));
    expect(marks.map((mark) => mark.key)).toEqual([
      'campaign',
      'email',
      'sms',
      'push',
    ]);
  });

  it('adds the creator mark only with creator codes', () => {
    const marks = campaignMarks(
      campaign({creators: [{name: 'Avery', codes: ['AVERY10']}]}),
    );
    expect(marks.find((mark) => mark.key === 'creator').description).toBe(
      'Avery posted a personal discount code.',
    );
  });

  it('clamps titles to 75 and descriptions to 150 characters', () => {
    const marks = campaignMarks(campaign({title: 'x'.repeat(200)}));
    for (const mark of marks) {
      expect(mark.title.length).toBeLessThanOrEqual(75);
      expect(mark.description.length).toBeLessThanOrEqual(150);
    }
    expect(clamp('abcdef', 4)).toBe('abc…');
  });
});

describe('touches', () => {
  it('keeps only marks that reached a customer, in date order', () => {
    const touches = touchMarks(
      campaign({creators: [{name: 'Avery', codes: ['A']}]}),
    );
    expect(touches.map((mark) => mark.key)).toEqual([
      'email',
      'push',
      'promo',
      'creator',
      'sms',
    ]);
    expect(lastTouch(touches, '2026-09-09')).toBeNull();
    expect(lastTouch(touches, '2026-09-19')).toBe('BOGO offer on Summer launch');
    expect(creatorTouches(campaign({creators: [{name: 'Avery', codes: ['A']}]}))).toEqual(
      ['Influencer drop for Summer launch'],
    );
  });
});

describe('creator codes', () => {
  it('sanitizes codes and quotes them for ShopifyQL', () => {
    expect(sanitizeCode("av'ery 10")).toBe('AVERY10');
    const codes = parseCreatorCodes("avery10:Avery, juno15:Juno, :nobody, bare");
    expect(codes).toEqual([
      {code: 'AVERY10', creator: 'Avery'},
      {code: 'JUNO15', creator: 'Juno'},
      {code: 'BARE', creator: 'bare'},
    ]);
    const creators = [
      {name: 'Avery', codes: ['AVERY10']},
      {name: 'Juno', codes: ['JUNO15', 'BARE']},
    ];
    expect(codeFilter({creators})).toBe(
      "discount_code IN ('AVERY10', 'JUNO15', 'BARE')",
    );
    expect(codeFilter({})).toBeNull();
  });
});

describe('dimensions', () => {
  it('quotes the resolved app namespace', () => {
    expect(metafieldDimension('gid://shopify/App/42', 'product', 'promoted_by')).toBe(
      'product.metafields."app--42--campaign_dashboard".promoted_by',
    );
  });
});

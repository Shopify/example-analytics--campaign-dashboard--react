import {afterEach, describe, expect, it, vi} from 'vitest';
import {sendBlocker, sendCampaignFunnel} from '../app/app-events.server';

const campaign = {startDate: '2026-09-10', endDate: '2026-10-07'};

describe('sendBlocker', () => {
  it('names the day the send schedule ends', () => {
    expect(sendBlocker(campaign, 'Etc/UTC', 'en', Date.parse('2026-09-12T00:00:00Z'))).toBe(
      'Available from Sep 23, when the 14-day send schedule ends.',
    );
  });

  it('allows a send once the schedule ends', () => {
    expect(sendBlocker(campaign, 'Etc/UTC', 'en', Date.parse('2026-09-30T00:00:00Z'))).toBeNull();
  });

  it('blocks a campaign shorter than the schedule', () => {
    expect(sendBlocker({...campaign, endDate: '2026-09-15'}, 'Etc/UTC', 'en')).toMatch(/runs 14 days/);
  });
});

describe('sendCampaignFunnel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the received count when one request throws', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/access_token')) {
        return new Response(JSON.stringify({access_token: 'test', expires_in: 3600}));
      }
      posts += 1;
      if (posts === 1) throw new TypeError('fetch failed');
      return new Response(null, {status: 202});
    }));
    const {accepted, failures} = await sendCampaignFunnel({
      shopId: 'gid://shopify/Shop/1',
      campaignId: 4210,
      startDate: '2026-09-10',
      timeZone: 'Etc/UTC',
      channels: ['email'],
    });
    const received = Object.values(accepted).reduce((sum, count) => sum + count, 0);
    expect(received).toBe(posts - 1);
    expect(failures[0]).toMatch(/network fetch failed/);
  });
});

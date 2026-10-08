import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {sendBlocker, sendCampaignFunnel} from '../app/app-events.server';
import {storedState} from './helpers/db';
import {base, planned, runWith} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {action: campaignAction} = await import('../app/routes/app.campaigns.$campaignId.jsx');
const run = runWith(campaignAction);

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

describe('send-events intent', () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const running = (overrides) => planned({status: 'running', ...overrides});

  it('refuses a campaign whose send is on the record', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const {result} = run(base(running({sentEvents: 9})), {intent: 'send-events'});
    expect(await result).toEqual({problems: ['Events already sent. Create a new campaign to send them again.']});
    expect(fetch).not.toHaveBeenCalled();
    expect(storedState(4210).sentEvents).toBe(9);
  });

  it('releases the claim when no event lands', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      url.endsWith('/access_token')
        ? new Response(JSON.stringify({access_token: 'test', expires_in: 3600}))
        : new Response(null, {status: 503}),
    ));
    const {result} = run(base(running()), {intent: 'send-events'});
    expect((await result).problems.length).toBeGreaterThan(0);
    expect(storedState(4210)).toMatchObject({campaignGid: 'gid://shopify/Metaobject/1', sentEvents: null});
  });

  it('records the count that landed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) =>
      url.endsWith('/access_token')
        ? new Response(JSON.stringify({access_token: 'test', expires_in: 3600}))
        : new Response(null, {status: 202}),
    ));
    const {result} = run(base(running()), {intent: 'send-events'});
    await result;
    expect(storedState(4210).sentEvents).toBeGreaterThan(0);
  });
});

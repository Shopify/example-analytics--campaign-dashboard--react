import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {sendBlocker, sendCampaignFunnel} from '../app/app-events.server';
import {storedState} from './helpers/db';
import {mockAdmin} from './helpers/admin';
import {base, planned, runWith, session} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {action: campaignAction} = await import('../app/routes/app.campaigns.$campaignId.jsx');
const {loader: overviewLoader} = await import('../app/routes/app.campaigns._index.jsx');
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
  const delays = [];
  beforeEach(() => {
    delays.length = 0;
    // Retries wait on setTimeout. Record the wait and run the callback now.
    vi.stubGlobal('setTimeout', (callback, ms) => {
      delays.push(ms);
      callback();
      return 0;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const token = () => new Response(JSON.stringify({access_token: 'test', expires_in: 3600}));
  const send = () =>
    sendCampaignFunnel({
      shopId: 'gid://shopify/Shop/1',
      campaignId: 4210,
      startDate: '2026-09-10',
      timeZone: 'Etc/UTC',
      channels: ['email'],
    });

  it('keeps the received count when one event never lands', async () => {
    let first = null;
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (url.endsWith('/access_token')) return token();
      posts += 1;
      const key = JSON.parse(init.body).idempotency_key;
      first ??= key;
      if (key === first) throw new TypeError('fetch failed');
      return new Response(null, {status: 202});
    }));
    const {accepted, failures} = await send();
    const received = Object.values(accepted).reduce((sum, count) => sum + count, 0);
    expect(received).toBe(posts - 3);
    expect(failures[0]).toMatch(/network fetch failed/);
  });

  it('sends one event at a time', async () => {
    let open = 0;
    let most = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/access_token')) return token();
      open += 1;
      most = Math.max(most, open);
      await Promise.resolve();
      open -= 1;
      return new Response(null, {status: 202});
    }));
    const {failures} = await send();
    expect(failures).toEqual([]);
    expect(most).toBe(1);
  });

  it('backs off on a 429 and retries with the same idempotency key', async () => {
    const keys = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (url.endsWith('/access_token')) return token();
      keys.push(JSON.parse(init.body).idempotency_key);
      return new Response(null, {status: keys.length < 3 ? 429 : 202});
    }));
    const {failures} = await send();
    expect(failures).toEqual([]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(delays).toEqual([250, 1000]);
  });

  it('reports an event that stays throttled after its retries', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/access_token')) return token();
      posts += 1;
      return new Response('slow down', {status: posts <= 3 ? 429 : 202});
    }));
    const {failures} = await send();
    expect(failures[0]).toMatch(/429 slow down/);
    expect(delays).toEqual([250, 1000]);
  });

  it('stops the send at the first event that stays throttled', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/access_token')) return token();
      posts += 1;
      return new Response('slow down', {status: 429});
    }));
    const {accepted, failures} = await send();
    expect(posts).toBe(3);
    expect(failures).toHaveLength(1);
    expect(Object.values(accepted).reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it("doesn't retry a rejected event", async () => {
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/access_token')) return token();
      posts += 1;
      return new Response('bad handle', {status: posts === 1 ? 400 : 202});
    }));
    const {failures} = await send();
    expect(failures[0]).toMatch(/400 bad handle/);
    expect(delays).toEqual([]);
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
    vi.stubGlobal('setTimeout', (callback) => (callback(), 0));
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

describe('overview sends', () => {
  it('keeps a failed send read apart from a store that sent nothing', async () => {
    const mock = mockAdmin({
      ...base(planned({status: 'running'})),
      CampaignTargets: () => ({data: {targets: []}}),
      CampaignComparison: () => ({data: null, errors: [{message: 'Access denied for app events'}]}),
    });
    session.admin = mock.raw;
    const data = await overviewLoader({request: new Request('https://app.test/app/campaigns')});
    expect(data.sendsUnavailable).toBe('Access denied for app events');
    expect(data.sends).toEqual([]);
  });
});

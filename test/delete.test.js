import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ops} from './helpers/admin';
import {seedState, tablesOf} from './helpers/db';
import {base, planned, resetTargets, runWith} from './helpers/routes';

vi.mock('../app/shopify.server', async () => (await import('./helpers/routes')).shopifyServer);

const {action: campaignAction} = await import('../app/routes/app.campaigns.$campaignId.jsx');
const run = runWith(campaignAction);

beforeEach(() => {
  resetTargets();
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('delete', () => {
  it("deletes the campaign's records with its entry", async () => {
    seedState({campaignId: 4211});
    const {result} = run(
      {
        ...base(planned({status: 'canceled', targets: {store: 'gid://shopify/AnalyticsTarget/1'}})),
        DeleteCampaign: () => ({data: {metaobjectDelete: {deletedId: 'x', userErrors: []}}}),
      },
      {intent: 'delete'},
    );
    await result;
    expect(tablesOf().campaignState.map((row) => row.campaignId)).toEqual([4211]);
  });

  it('deletes only a canceled campaign', async () => {
    const {mock, result} = run(base(planned()), {intent: 'delete'});
    expect(await result).toEqual({problems: ['Only a canceled campaign can be deleted.']});
    expect(ops(mock.calls)).not.toContain('DeleteCampaign');

    const canceled = run(
      {...base(planned({status: 'canceled'})), DeleteCampaign: () => ({data: {metaobjectDelete: {deletedId: 'x', userErrors: []}}})},
      {intent: 'delete'},
    );
    const response = await canceled.result;
    expect(response.headers.get('Location')).toBe('/app/campaigns');
    expect(response.headers.get('X-Authenticated-Redirect')).toBe('1');
    expect(canceled.mock.calls.find((call) => call.op === 'DeleteCampaign').variables).toEqual({id: 'gid://shopify/Metaobject/1'});
  });

  it('sends an action on a missing campaign back to the list', async () => {
    const {result} = run(base(planned({id: 4211})), {intent: 'close'});
    const response = await result;
    expect(response.headers.get('Location')).toBe('/app/campaigns');
    expect(response.headers.get('X-Authenticated-Redirect')).toBe('1');
  });

  it('leaves the creator entries for other campaigns', async () => {
    const avery = {id: 'gid://shopify/Metaobject/70', handle: 'creator-avery', name: 'Avery', codes: ['AVERY10']};
    const {mock, result} = run(
      {
        ...base(planned({status: 'canceled', creators: [avery]})),
        DeleteCampaign: () => ({data: {metaobjectDelete: {deletedId: 'x', userErrors: []}}}),
      },
      {intent: 'delete'},
    );
    await result;
    const deletes = mock.calls.filter((call) => call.op === 'DeleteCampaign');
    expect(deletes.map((call) => call.variables.id)).toEqual(['gid://shopify/Metaobject/1']);
    expect(ops(mock.calls).filter((op) => /Creator/.test(op))).toEqual([]);
  });
});

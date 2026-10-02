import {describe, expect, it} from 'vitest';
import {sendBlocker} from '../app/app-events.server';

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

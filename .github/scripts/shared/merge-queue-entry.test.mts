import assert from 'node:assert';
import { describe, it } from 'node:test';

import { verifyMergeQueueEntry } from './merge-queue-entry.mts';

describe('verifyMergeQueueEntry', () => {
  it('returns current when the queue entry matches the failed run SHA', async () => {
    const result = await verifyMergeQueueEntry({
      expectedHeadSha: 'current-sha',
      getHeadSha: async () => 'current-sha',
      sleep: async () => undefined,
    });

    assert.deepStrictEqual(result, {
      state: 'current',
      headSha: 'current-sha',
    });
  });

  it('returns stale when the queue entry is missing', async () => {
    const result = await verifyMergeQueueEntry({
      expectedHeadSha: 'current-sha',
      getHeadSha: async () => null,
      sleep: async () => undefined,
    });

    assert.deepStrictEqual(result, { state: 'stale' });
  });

  it('returns stale when the queue entry points to another SHA', async () => {
    const result = await verifyMergeQueueEntry({
      expectedHeadSha: 'current-sha',
      getHeadSha: async () => 'replacement-sha',
      sleep: async () => undefined,
    });

    assert.deepStrictEqual(result, {
      state: 'stale',
      headSha: 'replacement-sha',
    });
  });

  it('retries an API failure before returning the current entry', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await verifyMergeQueueEntry({
      expectedHeadSha: 'current-sha',
      getHeadSha: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('GitHub API unavailable');
        }
        return 'current-sha';
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    assert.deepStrictEqual(result, {
      state: 'current',
      headSha: 'current-sha',
    });
    assert.deepStrictEqual(delays, [1000, 2000]);
  });

  it('returns unverified after exhausting API retries', async () => {
    let calls = 0;
    const result = await verifyMergeQueueEntry({
      expectedHeadSha: 'current-sha',
      getHeadSha: async () => {
        calls += 1;
        throw new Error('GitHub API unavailable');
      },
      sleep: async () => undefined,
    });

    assert.deepStrictEqual(result, { state: 'unverified' });
    assert.strictEqual(calls, 3);
  });
});

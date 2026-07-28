import assert from 'node:assert';
import { describe, it } from 'node:test';

import { getRetryBudget, parseAttempt } from './retry-budget.mts';

describe('parseAttempt', () => {
  it('uses attempt 1 when the value is missing or invalid', () => {
    assert.strictEqual(parseAttempt(''), 1);
    assert.strictEqual(parseAttempt('abc'), 1);
    assert.strictEqual(parseAttempt(0), 1);
  });

  it('normalizes valid attempts to whole numbers', () => {
    assert.strictEqual(parseAttempt('2'), 2);
    assert.strictEqual(parseAttempt(3.9), 3);
  });
});

describe('getRetryBudget', () => {
  it('retries retryable PR failures on attempt 1 without a label', () => {
    assert.deepStrictEqual(
      getRetryBudget({
        attempt: 1,
        hasPr: true,
        hasRetryLabel: false,
        isRetryable: true,
      }),
      {
        attemptNumber: 1,
        atRetryLimit: false,
        consumeRetryLabel: false,
        retryLimit: 2,
        retryLimitSource: 'default',
        retryMode: 'automatic',
        willRetry: true,
      },
    );
  });

  it('does not consume retry-ci when attempt 1 is inside the default budget', () => {
    const decision = getRetryBudget({
      attempt: 1,
      hasPr: true,
      hasRetryLabel: true,
      isRetryable: true,
    });

    assert.strictEqual(decision.retryMode, 'automatic');
    assert.strictEqual(decision.consumeRetryLabel, false);
    assert.strictEqual(decision.willRetry, true);
  });

  it('stops at attempt 2 without retry-ci', () => {
    const decision = getRetryBudget({
      attempt: 2,
      hasPr: true,
      hasRetryLabel: false,
      isRetryable: true,
    });

    assert.strictEqual(decision.atRetryLimit, true);
    assert.strictEqual(decision.retryLimit, 2);
    assert.strictEqual(decision.retryMode, 'none');
    assert.strictEqual(decision.willRetry, false);
  });

  it('uses retry-ci to retry attempts 2 and 3', () => {
    for (const attempt of [2, 3]) {
      const decision = getRetryBudget({
        attempt,
        hasPr: true,
        hasRetryLabel: true,
        isRetryable: true,
      });

      assert.strictEqual(decision.consumeRetryLabel, true);
      assert.strictEqual(decision.retryLimit, 4);
      assert.strictEqual(decision.retryLimitSource, 'retry-ci');
      assert.strictEqual(decision.retryMode, 'label');
      assert.strictEqual(decision.willRetry, true);
    }
  });

  it('stops at attempt 4 even with retry-ci', () => {
    const decision = getRetryBudget({
      attempt: 4,
      hasPr: true,
      hasRetryLabel: true,
      isRetryable: true,
    });

    assert.strictEqual(decision.atRetryLimit, true);
    assert.strictEqual(decision.retryLimit, 4);
    assert.strictEqual(decision.retryMode, 'none');
    assert.strictEqual(decision.willRetry, false);
  });

  it('does not retry non-retryable failures', () => {
    const decision = getRetryBudget({
      attempt: 1,
      hasPr: true,
      hasRetryLabel: true,
      isRetryable: false,
    });

    assert.strictEqual(decision.atRetryLimit, false);
    assert.strictEqual(decision.retryMode, 'none');
    assert.strictEqual(decision.willRetry, false);
  });

  it('does not retry runs without an originating PR', () => {
    const decision = getRetryBudget({
      attempt: 1,
      hasPr: false,
      hasRetryLabel: false,
      isRetryable: true,
    });

    assert.strictEqual(decision.atRetryLimit, false);
    assert.strictEqual(decision.retryMode, 'none');
    assert.strictEqual(decision.willRetry, false);
  });
});

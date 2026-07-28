export const DEFAULT_RETRY_MAX_ATTEMPT = 2;
export const RETRY_CI_LABEL_MAX_ATTEMPT = 4;

export type RetryMode = 'automatic' | 'label' | 'none';
export type RetryLimitSource = 'default' | 'retry-ci';

export interface RetryBudgetInput {
  attempt: number | string;
  hasPr: boolean;
  hasRetryLabel: boolean;
  isRetryable: boolean;
}

export interface RetryBudgetDecision {
  attemptNumber: number;
  atRetryLimit: boolean;
  consumeRetryLabel: boolean;
  retryLimit: number;
  retryLimitSource: RetryLimitSource;
  retryMode: RetryMode;
  willRetry: boolean;
}

export function parseAttempt(attempt: number | string): number {
  const attemptNumber =
    typeof attempt === 'number' ? attempt : Number.parseInt(attempt, 10);

  if (!Number.isFinite(attemptNumber) || attemptNumber < 1) {
    return 1;
  }

  return Math.floor(attemptNumber);
}

export function getRetryBudget({
  attempt,
  hasPr,
  hasRetryLabel,
  isRetryable,
}: RetryBudgetInput): RetryBudgetDecision {
  const attemptNumber = parseAttempt(attempt);
  // The label raises the retry ceiling, but attempt 1 is always funded by the
  // default budget. It is consumed only when it authorizes retries 2 or 3.
  const retryLimit = hasRetryLabel
    ? RETRY_CI_LABEL_MAX_ATTEMPT
    : DEFAULT_RETRY_MAX_ATTEMPT;
  const retryLimitSource: RetryLimitSource = hasRetryLabel
    ? 'retry-ci'
    : 'default';
  const willRetry = isRetryable && hasPr && attemptNumber < retryLimit;
  const retryMode: RetryMode = !willRetry
    ? 'none'
    : attemptNumber < DEFAULT_RETRY_MAX_ATTEMPT
      ? 'automatic'
      : 'label';

  return {
    attemptNumber,
    atRetryLimit: isRetryable && hasPr && attemptNumber >= retryLimit,
    consumeRetryLabel: retryMode === 'label',
    retryLimit,
    retryLimitSource,
    retryMode,
    willRetry,
  };
}

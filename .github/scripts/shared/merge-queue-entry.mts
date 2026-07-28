export type MergeQueueEntryState = 'current' | 'stale' | 'unverified';

export interface MergeQueueEntryVerification {
  state: MergeQueueEntryState;
  headSha?: string;
}

export interface VerifyMergeQueueEntryOptions {
  expectedHeadSha: string;
  getHeadSha: () => Promise<string | null>;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface VerifyMergeQueueRetryOptions
  extends VerifyMergeQueueEntryOptions {
  refExists: () => Promise<boolean>;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function verifyMergeQueueEntry({
  expectedHeadSha,
  getHeadSha,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  sleep = defaultSleep,
}: VerifyMergeQueueEntryOptions): Promise<MergeQueueEntryVerification> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headSha = await getHeadSha();
      if (headSha === expectedHeadSha) {
        return { state: 'current', headSha };
      }
      return { state: 'stale', ...(headSha ? { headSha } : {}) };
    } catch {
      if (attempt === maxAttempts) {
        return { state: 'unverified' };
      }
      await sleep(attempt * 1000);
    }
  }

  return { state: 'unverified' };
}

export async function verifyMergeQueueRetry({
  refExists,
  ...entryOptions
}: VerifyMergeQueueRetryOptions): Promise<MergeQueueEntryVerification> {
  const entryVerification = await verifyMergeQueueEntry(entryOptions);
  if (entryVerification.state !== 'current') {
    return entryVerification;
  }

  return (await refExists())
    ? entryVerification
    : { state: 'stale', headSha: entryVerification.headSha };
}
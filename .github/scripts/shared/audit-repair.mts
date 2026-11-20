export type FailedJob = {
  name: string;
  failedSteps: string[];
  id?: number;
  /** Whole job log; only fetched for jobs whose class depends on it (the failure text sits before the cleanup lines). */
  log?: string;
};

export type FailureKind =
  | 'cascade'
  | 'allow-scripts'
  | 'dedupe'
  | 'lavamoat-policy'
  | 'depcheck'
  | 'lint'
  | 'lint-heap'
  | 'e2e'
  | 'unit-test'
  | 'build'
  | 'unknown';

/** Repairs a script can apply without an LLM, in the order they must run. */
export type DeterministicRepair =
  | 'allow-scripts'
  | 'dedupe'
  | 'lavamoat-policy';

const DETERMINISTIC_ORDER: DeterministicRepair[] = [
  'allow-scripts',
  'dedupe',
  'lavamoat-policy',
];

type Rule = { kind: FailureKind; job?: RegExp; step?: RegExp; log?: RegExp };

/** Jobs whose class depends on the log, so the caller fetches it for them. */
export const LOG_CLASSIFIED_JOB = /^Test lint\b/iu;

// First match wins, so the narrow step rules come before the broad job rules.
const RULES: Rule[] = [
  { kind: 'cascade', job: /\bCI status gate\b|^all-jobs-pass$/iu },
  { kind: 'dedupe', step: /Detect yarn lock deduplications/iu },
  { kind: 'allow-scripts', step: /allow-scripts/iu },
  {
    kind: 'lavamoat-policy',
    job: /Validate LavaMoat .*policy/iu,
    step: /Check working tree/iu,
  },
  { kind: 'depcheck', step: /depcheck/iu },
  {
    kind: 'lint-heap',
    job: LOG_CLASSIFIED_JOB,
    log: /JavaScript heap out of memory|Reached heap limit/iu,
  },
  { kind: 'lint', job: LOG_CLASSIFIED_JOB },
  { kind: 'e2e', job: /\be2e\b/iu },
  { kind: 'unit-test', job: /\b(test-unit|unit|integration|jest)\b/iu },
  { kind: 'build', job: /\bbuild\b/iu },
];

export function classifyJob(job: FailedJob): FailureKind {
  for (const rule of RULES) {
    const jobMatches = !rule.job || rule.job.test(job.name);
    const stepMatches =
      !rule.step || job.failedSteps.some((step) => rule.step?.test(step));
    const logMatches = !rule.log || rule.log.test(job.log ?? '');
    if (jobMatches && stepMatches && logMatches) {
      return rule.kind;
    }
  }
  return 'unknown';
}

export type RepairPlan = {
  action: 'none' | 'repair' | 'retry' | 'llm' | 'needs-human';
  /** Deterministic repairs to apply this round, in order. */
  steps: DeterministicRepair[];
  /** Failures left for a later round. */
  deferred: FailureKind[];
  reason: string;
  /** Stable text for the failure set, to detect a round that changed nothing. */
  signature: string;
};

export type DecideInput = {
  failures: FailedJob[];
  /** Repair commits already pushed to the branch. */
  repairsSoFar: number;
  cap: number;
  /** Signature of the failure set that the previous repair round saw. */
  previousSignature?: string;
  /** Attempt number of the failing CI run; a failed second attempt is not a flake. */
  runAttempt: number;
};

const unique = <Item,>(items: Item[]): Item[] => [...new Set(items)];

/**
 * Chooses what the repair job does for one failed CI run. Dedupe and
 * allow-scripts change `yarn.lock` or `package.json`, which stales the
 * LavaMoat policy diff CI produced for the old tree, so the policy repair
 * waits for the next CI run when either is present.
 */
export function decideRepair({
  failures,
  repairsSoFar,
  cap,
  previousSignature,
  runAttempt,
}: DecideInput): RepairPlan {
  // One entry per failed step, so a job failing two checks reports both.
  const classified = failures
    .flatMap((job) =>
      (job.failedSteps.length > 0 ? job.failedSteps : ['']).map((step) => ({
        ...job,
        failedSteps: [step],
      })),
    )
    .map((job) => ({ job, kind: classifyJob(job) }))
    .filter(({ kind }) => kind !== 'cascade');
  const kinds = unique(classified.map(({ kind }) => kind));
  const signature = classified
    .map(({ job, kind }) => `${kind}:${job.name}:${job.failedSteps[0]}`)
    .sort()
    .join('|');
  const plan = (
    action: RepairPlan['action'],
    reason: string,
    steps: DeterministicRepair[] = [],
    deferred: FailureKind[] = [],
  ): RepairPlan => ({ action, steps, deferred, reason, signature });

  if (kinds.length === 0) {
    return plan('none', 'No failure other than the status gate.');
  }
  if (repairsSoFar >= cap) {
    return plan('needs-human', `Repair cap of ${cap} reached.`);
  }
  if (previousSignature !== undefined && previousSignature === signature) {
    return plan('needs-human', 'The last repair did not change what fails.');
  }

  const deterministic = DETERMINISTIC_ORDER.filter((kind) =>
    kinds.includes(kind),
  );
  if (deterministic.length > 0) {
    const waitForTree =
      deterministic.includes('allow-scripts') ||
      deterministic.includes('dedupe');
    const steps = waitForTree
      ? deterministic.filter((kind) => kind !== 'lavamoat-policy')
      : deterministic;
    const deferred = kinds.filter(
      (kind) => !(steps as FailureKind[]).includes(kind),
    );
    return plan('repair', `Apply ${steps.join(', ')}.`, steps, deferred);
  }

  if (kinds.includes('unknown')) {
    return plan('needs-human', 'A failure matches no known class.');
  }
  if (kinds.every((kind) => kind === 'e2e' || kind === 'unit-test')) {
    return runAttempt < 2
      ? plan('retry', 'Only test jobs failed; rerun once to rule out a flake.')
      : plan('llm', 'Test jobs failed again on the second attempt.');
  }
  return plan('llm', `Needs a code repair: ${kinds.join(', ')}.`);
}

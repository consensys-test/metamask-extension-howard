import {
  classifyJob,
  decideRepair,
  type FailedJob,
  type DecideInput,
} from './audit-repair.mts';

// The failed jobs of Main run 44397185397 (attempt 1) on the bot's audit commit.
const lint: FailedJob = { name: 'Test lint', failedSteps: ['Lint'] };
const policyMv2: FailedJob = {
  name: 'validate-lavamoat-policies / Validate LavaMoat webpack MV2 policy',
  failedSteps: ['Check working tree'],
};
const policyMv3: FailedJob = {
  name: 'validate-lavamoat-policies / Validate LavaMoat webpack MV3 policy',
  failedSteps: ['Check working tree'],
};
const health: FailedJob = {
  name: 'repository-health-checks / Repository health checks',
  failedSteps: ['Detect yarn lock deduplications', 'Run depcheck'],
};
const e2e: FailedJob = {
  name: 'e2e-chrome / test-e2e-chrome-webpack (5) / test-e2e-chrome-webpack (5)',
  failedSteps: ['Run E2E tests'],
};
const gate: FailedJob = {
  name: 'ci-status-gate / CI status gate (controls all-jobs-pass)',
  failedSteps: ['Fail job if checks failed'],
};

const decide = (failures: FailedJob[], overrides: Partial<DecideInput> = {}) =>
  decideRepair({
    failures,
    repairsSoFar: 0,
    cap: 3,
    runAttempt: 1,
    ...overrides,
  });

describe('classifyJob', () => {
  const cases: [FailedJob, ReturnType<typeof classifyJob>][] = [
    [lint, 'lint'],
    [policyMv2, 'lavamoat-policy'],
    [policyMv3, 'lavamoat-policy'],
    [health, 'dedupe'],
    [e2e, 'e2e'],
    [gate, 'cascade'],
  ];
  for (const [job, kind] of cases) {
    it(`classifies ${job.name} as ${kind}`, () => {
      expect(classifyJob(job)).toBe(kind);
    });
  }

  it('classifies a depcheck-only health failure as depcheck', () => {
    expect(classifyJob({ ...health, failedSteps: ['Run depcheck'] })).toBe(
      'depcheck',
    );
  });

  it('classifies an allow-scripts step as allow-scripts', () => {
    expect(
      classifyJob({
        ...health,
        failedSteps: ['Validate allow-scripts config'],
      }),
    ).toBe('allow-scripts');
  });

  it('does not treat another failed LavaMoat step as a policy diff', () => {
    expect(
      classifyJob({ ...policyMv2, failedSteps: ['Install dependencies'] }),
    ).not.toBe('lavamoat-policy');
  });

  it('classifies an unrecognised job as unknown', () => {
    expect(classifyJob({ name: 'Deploy docs', failedSteps: ['Push'] })).toBe(
      'unknown',
    );
  });
});

describe('decideRepair', () => {
  it('defers the policy repair while dedupe changes the tree', () => {
    const plan = decide([lint, policyMv2, policyMv3, health, e2e, gate]);

    expect(plan.action).toBe('repair');
    expect(plan.steps).toStrictEqual(['dedupe']);
    expect(plan.deferred).toStrictEqual(
      expect.arrayContaining(['lavamoat-policy', 'depcheck', 'lint', 'e2e']),
    );
  });

  it('applies the policy repair when nothing else changes the tree', () => {
    const plan = decide([policyMv2, policyMv3, gate]);

    expect(plan).toMatchObject({
      action: 'repair',
      steps: ['lavamoat-policy'],
      deferred: [],
    });
  });

  it('orders allow-scripts before dedupe', () => {
    const plan = decide([
      health,
      {
        ...health,
        name: 'other',
        failedSteps: ['Validate allow-scripts config'],
      },
    ]);

    expect(plan.steps).toStrictEqual(['allow-scripts', 'dedupe']);
  });

  it('does nothing when only the status gate failed', () => {
    expect(decide([gate]).action).toBe('none');
  });

  it('retries a test-only failure once, then asks for a code repair', () => {
    expect(decide([e2e, gate]).action).toBe('retry');
    expect(decide([e2e, gate], { runAttempt: 2 }).action).toBe('llm');
  });

  it('asks for a code repair for lint', () => {
    expect(decide([lint]).action).toBe('llm');
  });

  it('hands an unknown failure to a human', () => {
    expect(
      decide([{ name: 'Deploy docs', failedSteps: ['Push'] }]).action,
    ).toBe('needs-human');
  });

  it('stops at the repair cap', () => {
    expect(decide([health], { repairsSoFar: 3 })).toMatchObject({
      action: 'needs-human',
      reason: 'Repair cap of 3 reached.',
    });
  });

  it('stops when the last repair left the same failures', () => {
    const first = decide([health]);

    expect(
      decide([health], { previousSignature: first.signature }).action,
    ).toBe('needs-human');
  });

  it('gives the same signature regardless of job order', () => {
    expect(decide([lint, e2e]).signature).toBe(decide([e2e, lint]).signature);
  });
});

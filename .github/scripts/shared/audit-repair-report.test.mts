import {
  buildReport,
  parseState,
  REPORT_MARKER,
  type ReportInput,
} from './audit-repair-report.mts';

const base: ReportInput = {
  plan: { action: 'repair', steps: ['dedupe'], reason: 'Apply dedupe.' },
  outcome: 'pushed',
  sha: '6a15f9b2331877b338ee798108b46f13ebab318a',
  repairsSoFar: 1,
  cap: 3,
  runId: '200',
  runUrl: 'https://github.com/o/r/actions/runs/200',
  previous: [],
  dryRun: false,
};

describe('buildReport', () => {
  it('reports a pushed round with the rounds used out of the cap', () => {
    const body = buildReport(base);

    expect(body.startsWith(REPORT_MARKER)).toBe(true);
    expect(body).toContain('in progress');
    expect(body).toContain('Round 2 of 3 pushed `6a15f9b2331`');
    expect(body).toContain('**Rounds used:** 2 of 3');
  });

  it('says the last allowed round was the last', () => {
    expect(buildReport({ ...base, repairsSoFar: 2 })).toContain(
      'last round the cap allows',
    );
  });

  it('states why the loop stopped when the planner needs a human', () => {
    const body = buildReport({
      ...base,
      plan: {
        action: 'needs-human',
        steps: [],
        reason: 'Repair cap of 3 reached.',
      },
      outcome: 'needs-human',
      repairsSoFar: 3,
    });

    expect(body).toContain('### Audit repair: stopped');
    expect(body).toContain('A human is needed: Repair cap of 3 reached.');
    expect(body).toContain('**Rounds used:** 3 of 3');
  });

  it('explains a round that did not push', () => {
    const body = buildReport({
      ...base,
      plan: { action: 'llm', steps: [], reason: 'Needs a code repair: lint.' },
      outcome: 'proof-failed',
      repairsSoFar: 0,
    });

    expect(body).toContain('no push, because the failing check still fails');
    expect(body).toContain('CI does not run again');
    expect(body).toContain('**Rounds used:** 0 of 3');
  });

  it('reports a run that died before the plan', () => {
    expect(
      buildReport({ ...base, plan: undefined, outcome: 'unfinished' }),
    ).toContain('failed before it made a plan');
  });

  it('adds up the LLM cost across rounds and replaces a rerun of the same run', () => {
    const first = buildReport({ ...base, runId: '100', costUsd: 0.5 });
    const second = buildReport({
      ...base,
      runId: '200',
      costUsd: 0.25,
      previous: parseState(first),
    });
    const rerun = buildReport({
      ...base,
      runId: '200',
      costUsd: 0.4,
      previous: parseState(second),
    });

    expect(second).toContain('approximately $0.75 across 2 runs');
    expect(rerun).toContain('approximately $0.90 across 2 runs');
    expect(rerun.match(/^\| 200 /gmu)).toHaveLength(1);
  });

  it('says no LLM spend when only deterministic rounds ran', () => {
    expect(buildReport(base)).toContain('**LLM spend:** none so far.');
  });

  it('marks a dry run', () => {
    expect(
      buildReport({ ...base, outcome: 'dry-run', dryRun: true }),
    ).toContain('(dry run)');
  });
});

describe('parseState', () => {
  it('ignores a comment without state or with damaged state', () => {
    expect(parseState(undefined)).toStrictEqual([]);
    expect(parseState('hello')).toStrictEqual([]);
    expect(parseState('<!-- audit-repair-state not-json -->')).toStrictEqual(
      [],
    );
  });
});

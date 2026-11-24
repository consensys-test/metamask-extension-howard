import {
  buildReport,
  parseAutofixCost,
  parseState,
  quoteAgentText,
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

  it('explains a rejected push', () => {
    expect(buildReport({ ...base, outcome: 'push-failed' })).toContain(
      'the push was rejected',
    );
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

    expect(second).toContain(
      'approximately $0.75 in total (2 repair runs $0.75',
    );
    expect(rerun).toContain(
      'approximately $0.90 in total (2 repair runs $0.90',
    );
    expect(rerun.match(/^\| 200 /gmu)).toHaveLength(1);
  });

  it('says no LLM spend when only deterministic rounds ran', () => {
    expect(buildReport(base)).toContain('**LLM spend:** none recorded.');
  });

  it('adds the autofix run to the running total', () => {
    const body = buildReport({ ...base, costUsd: 0.25, autofixCostUsd: 0.5 });

    expect(body).toContain(
      'approximately $0.75 in total (autofix run $0.50 + 1 repair run $0.25;',
    );
    expect(buildReport({ ...base, autofixCostUsd: 0.37 })).toContain(
      'approximately $0.37 in total (autofix run $0.37;',
    );
  });

  it('shows the agent report when the agent handed the failure over', () => {
    const body = buildReport({
      ...base,
      plan: { action: 'llm', steps: [], reason: 'Needs a code repair.' },
      outcome: 'no-change',
      agentReport: 'No dependency change; lint fails on a markdown file.',
    });

    expect(body).toContain('the agent made no change and handed the failure');
    expect(body).toContain("<summary>The agent's report</summary>");
    expect(body).toContain('lint fails on a markdown file.');
  });

  it('leaves out an agent report for a deterministic round', () => {
    expect(buildReport({ ...base, agentReport: 'stale' })).not.toContain(
      "agent's report",
    );
  });

  it('closes the comment when Main passes after a repair', () => {
    const first = buildReport(base);
    const body = buildReport({
      ...base,
      plan: undefined,
      outcome: 'green',
      runId: '300',
      previous: parseState(first),
    });
    expect(body).toContain('### Audit repair: done');
    expect(body).toContain('Main passed after 1 repair round.');
    expect(body).toContain('**Rounds used:** 1 of 3');
    expect(body).toContain('| 300 | - | - | green | - |');
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

describe('parseAutofixCost', () => {
  it('reads the spend line of the autofix PR body', () => {
    expect(
      parseAutofixCost(
        '**LLM spend:** approximately $1.23 (estimated by Claude Code, not the billed amount).',
      ),
    ).toBe(1.23);
    expect(parseAutofixCost('**LLM spend:** not reported.')).toBeUndefined();
    expect(parseAutofixCost(undefined)).toBeUndefined();
  });
});

describe('quoteAgentText', () => {
  it('stops pings and forged markers and bounds the length', () => {
    const quoted = quoteAgentText('hi @octocat <!-- audit-repair-status -->');

    expect(quoted).not.toContain('@octocat');
    expect(quoted).not.toContain('<!--');
    expect(quoteAgentText('x'.repeat(50), 10)).toContain(
      'cut at 10 characters',
    );
  });
});

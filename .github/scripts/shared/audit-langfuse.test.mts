import {
  buildLangfuseBatch,
  parseClaudeRun,
  traceId,
} from './audit-langfuse.mts';
import type { TraceInput } from './audit-langfuse.mts';

const base: TraceInput = {
  workflow: 'audit-autofix',
  runId: '100',
  runAttempt: '1',
  runUrl: 'https://github.com/o/r/actions/runs/100',
  repository: 'o/r',
  model: 'claude-sonnet-5-5',
  outcome: 'pushed',
  now: new Date('2026-11-24T10:00:00Z'),
};

describe('buildLangfuseBatch', () => {
  it('builds a trace and an agent generation with usage and cost', () => {
    const { batch } = buildLangfuseBatch({
      ...base,
      run: {
        numTurns: 12,
        durationMs: 60_000,
        totalCostUsd: 1.25,
        usage: { inputTokens: 5, outputTokens: 7 },
      },
    });

    expect(batch.map((event) => event.type)).toStrictEqual([
      'trace-create',
      'generation-create',
    ]);
    expect(batch[0].body).toMatchObject({
      id: 'audit-autofix-100-1',
      tags: ['audit-autofix', 'audit-autofix'],
      output: 'pushed',
    });
    expect(batch[1].body).toMatchObject({
      traceId: 'audit-autofix-100-1',
      model: 'claude-sonnet-5-5',
      level: 'DEFAULT',
      startTime: '2026-11-24T09:59:00.000Z',
      usageDetails: { inputTokens: 5, outputTokens: 7 },
      costDetails: { total: 1.25 },
    });
  });

  it('marks a failed agent run as an error', () => {
    const { batch } = buildLangfuseBatch({
      ...base,
      run: { isError: true, usage: {} },
    });

    expect(batch[1].body).toMatchObject({ level: 'ERROR' });
  });

  it('reads the snake_case result line of Claude Code', () => {
    expect(
      parseClaudeRun(
        JSON.parse(
          '{"is_error":true,"num_turns":3,"duration_ms":10,"total_cost_usd":0.5,"usage":{"input_tokens":1,"output_tokens":2,"service_tier":"standard"}}',
        ),
      ),
    ).toStrictEqual({
      isError: true,
      numTurns: 3,
      durationMs: 10,
      totalCostUsd: 0.5,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('sends only the trace when no agent result exists', () => {
    expect(buildLangfuseBatch(base).batch).toHaveLength(1);
  });

  it('gives a rerun of the same attempt the same trace id', () => {
    expect(traceId(base)).toBe(traceId({ ...base, outcome: 'green' }));
  });
});

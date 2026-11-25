// The Langfuse trace for one audit autofix or repair run. Only counts, ids and the outcome go in:
// no transcript, no diff, no log text.
import { randomUUID } from 'node:crypto';

/** The fields of Claude Code's final `result` line that the trace uses. */
export type ClaudeRun = {
  isError?: boolean;
  numTurns?: number;
  durationMs?: number;
  totalCostUsd?: number;
  usage: Record<string, number>;
};

const USAGE_KEYS = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
] as const;

/** Reads Claude Code's snake_case result line. */
export function parseClaudeRun(result: Record<string, unknown>): ClaudeRun {
  const usage: Record<string, number> = {};
  const raw = (result.usage ?? {}) as Record<string, unknown>;
  for (const [from, to] of USAGE_KEYS) {
    if (typeof raw[from] === 'number') {
      usage[to] = raw[from];
    }
  }
  const number = (key: string): number | undefined =>
    typeof result[key] === 'number' ? result[key] : undefined;
  return {
    isError: result.is_error === true,
    numTurns: number('num_turns'),
    durationMs: number('duration_ms'),
    totalCostUsd: number('total_cost_usd'),
    usage,
  };
}

export type TraceInput = {
  /** `audit-autofix` or `audit-repair`. */
  workflow: string;
  runId: string;
  runAttempt: string;
  runUrl: string;
  repository: string;
  model: string;
  outcome: string;
  /** Undefined when the run ended before the agent ran or wrote its result. */
  run?: ClaudeRun;
  now?: Date;
};

type Event = { id: string; timestamp: string; type: string; body: object };

/** Same id for a rerun of the same attempt, so Langfuse updates the trace instead of adding one. */
export function traceId(input: TraceInput): string {
  return `${input.workflow}-${input.runId}-${input.runAttempt}`;
}

export function buildLangfuseBatch(input: TraceInput): { batch: Event[] } {
  const end = input.now ?? new Date();
  const timestamp = end.toISOString();
  const id = traceId(input);
  const { run } = input;
  const metadata = {
    repository: input.repository,
    runUrl: input.runUrl,
    outcome: input.outcome,
    ...(run?.numTurns === undefined ? {} : { turns: run.numTurns }),
  };
  const events: Event[] = [
    {
      id: randomUUID(),
      timestamp,
      type: 'trace-create',
      body: {
        id,
        name: input.workflow,
        timestamp,
        tags: ['audit-autofix', input.workflow],
        metadata,
        output: input.outcome,
      },
    },
  ];
  if (run) {
    events.push({
      id: randomUUID(),
      timestamp,
      type: 'generation-create',
      body: {
        id: `${id}-agent`,
        traceId: id,
        name: 'agent',
        model: input.model,
        startTime: new Date(
          end.getTime() - (run.durationMs ?? 0),
        ).toISOString(),
        endTime: timestamp,
        level: run.isError ? 'ERROR' : 'DEFAULT',
        usageDetails: run.usage,
        ...(run.totalCostUsd === undefined
          ? {}
          : { costDetails: { total: run.totalCostUsd } }),
        metadata: { turns: run.numTurns, estimatedBy: 'Claude Code' },
      },
    });
  }
  return { batch: events };
}

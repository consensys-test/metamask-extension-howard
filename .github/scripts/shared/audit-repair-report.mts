// The PR comment the audit repair job keeps up to date: where the loop stands, why it stopped,
// and what the LLM has cost so far.

export const REPORT_MARKER = '<!-- audit-repair-status -->';
const STATE_OPEN = '<!-- audit-repair-state ';
const STATE_CLOSE = ' -->';

export type Round = {
  run: string;
  action: string;
  steps: string[];
  outcome: string;
  costUsd?: number;
};

export type ReportInput = {
  /** Undefined when the run died before it wrote a plan. */
  plan?: { action: string; steps: string[]; reason: string };
  /** What happened after the plan; see the "Record what happened" step. */
  outcome: string;
  sha?: string;
  repairsSoFar: number;
  cap: number;
  costUsd?: number;
  runId: string;
  runUrl: string;
  previous: Round[];
  dryRun: boolean;
  /** The repair-report.md the agent wrote; only an LLM round has one. */
  agentReport?: string;
  /** Cost of the autofix run that opened the PR, read from the PR body. */
  autofixCostUsd?: number;
};

const NO_PUSH: Record<string, string> = {
  'agent-failed': 'the agent step failed',
  'verify-failed': 'the repaired tree failed the verification',
  'proof-failed': 'the failing check still fails on the repaired tree',
  'push-failed':
    'the push was rejected, usually because the branch moved after the failed run',
  'no-change': 'the repair changed nothing',
  unfinished: 'a repair step failed or the run was cancelled',
};

/** The autofix run's own spend line in the PR body, if it has one. */
export function parseAutofixCost(
  prBody: string | undefined,
): number | undefined {
  const match = prBody?.match(
    /\*\*LLM spend:\*\* approximately \$(\d+(?:\.\d+)?)/u,
  );
  return match ? Number(match[1]) : undefined;
}

/** Agent text goes into a comment: no pings, no forged markers, bounded length. */
export function quoteAgentText(text: string, max = 3000): string {
  const clipped =
    text.length > max
      ? `${text.slice(0, max)}\n\n(cut at ${max} characters)`
      : text;
  return clipped
    .replace(/<!--/gu, '&lt;!--')
    .replace(/@(?=\w)/gu, '@\u200b')
    .trim();
}

/** Rounds recorded by earlier comments, kept in a hidden base64 block so `-->` cannot end it. */
export function parseState(body: string | undefined): Round[] {
  const start = body?.indexOf(STATE_OPEN) ?? -1;
  if (!body || start === -1) {
    return [];
  }
  const from = start + STATE_OPEN.length;
  const end = body.indexOf(STATE_CLOSE, from);
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(body.slice(from, end), 'base64').toString('utf8'),
    );
    return Array.isArray(parsed) ? (parsed as Round[]) : [];
  } catch {
    return [];
  }
}

function headline(input: ReportInput): { text: string; stopped: boolean } {
  const { plan, outcome, repairsSoFar, cap } = input;
  const round = repairsSoFar + 1;
  if (!plan) {
    return {
      text: 'The repair run failed before it made a plan. See the run log.',
      stopped: true,
    };
  }
  if (outcome === 'pushed') {
    const last = round >= cap ? ' This was the last round the cap allows.' : '';
    return {
      text: `Round ${round} of ${cap} pushed${input.sha ? ` \`${input.sha.slice(0, 11)}\`` : ''}. Main runs again on it, and what still fails decides whether another round follows.${last}`,
      stopped: false,
    };
  }
  if (plan.action === 'needs-human') {
    return {
      text: `Stopped. A human is needed: ${plan.reason}`,
      stopped: true,
    };
  }
  if (plan.action === 'none') {
    return { text: `Stopped. ${plan.reason}`, stopped: true };
  }
  if (plan.action === 'retry') {
    return {
      text: 'Reran the failed jobs once. A second failure of the same jobs goes to the repair.',
      stopped: false,
    };
  }
  if (outcome === 'dry-run') {
    return {
      text: `Dry run of round ${round}: nothing was pushed.`,
      stopped: true,
    };
  }
  if (plan.action === 'llm' && outcome === 'no-change') {
    return {
      text: `Stopped in round ${round}: the agent made no change and handed the failure to a human. Its report is below. The branch is unchanged, so CI does not run again.`,
      stopped: true,
    };
  }
  const why = NO_PUSH[outcome] ?? `the run ended as "${outcome}"`;
  return {
    text: `Stopped in round ${round}: no push, because ${why}. The branch is unchanged, so CI does not run again.`,
    stopped: true,
  };
}

export function buildReport(input: ReportInput): string {
  const current: Round = {
    run: input.runId,
    action: input.plan?.action ?? 'none',
    steps: input.plan?.steps ?? [],
    outcome: input.outcome,
    ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
  };
  const rounds = [
    ...input.previous.filter((round) => round.run !== input.runId),
    current,
  ];
  const { text, stopped } = headline(input);
  const used = input.repairsSoFar + (input.outcome === 'pushed' ? 1 : 0);
  const priced = rounds.filter((round) => round.costUsd !== undefined);
  const repairs = priced.reduce((sum, round) => sum + (round.costUsd ?? 0), 0);
  const total = repairs + (input.autofixCostUsd ?? 0);
  const parts = [
    input.autofixCostUsd === undefined
      ? undefined
      : `autofix run $${input.autofixCostUsd.toFixed(2)}`,
    priced.length === 0
      ? undefined
      : `${priced.length} repair run${priced.length === 1 ? '' : 's'} $${repairs.toFixed(2)}`,
  ].filter(Boolean);
  const agentReport = input.plan?.action === 'llm' && input.agentReport?.trim();

  const lines = [
    REPORT_MARKER,
    `### Audit repair: ${stopped ? 'stopped' : 'in progress'}${input.dryRun ? ' (dry run)' : ''}`,
    '',
    text,
    '',
    `**Rounds used:** ${used} of ${input.cap}`,
    parts.length === 0
      ? '**LLM spend:** none recorded.'
      : `**LLM spend:** approximately $${total.toFixed(2)} in total (${parts.join(' + ')}; estimated by Claude Code, not the billed amount).`,
    '',
    '| Run | Plan | Steps | Outcome | LLM cost |',
    '| --- | --- | --- | --- | --- |',
    ...rounds.map(
      (round) =>
        `| ${round.run} | ${round.action} | ${round.steps.join(', ') || '-'} | ${round.outcome} | ${round.costUsd === undefined ? '-' : `$${round.costUsd.toFixed(2)}`} |`,
    ),
    ...(agentReport
      ? [
          '',
          "<details><summary>The agent's report</summary>",
          '',
          quoteAgentText(agentReport),
          '',
          '</details>',
        ]
      : []),
    '',
    `[Latest run](${input.runUrl})`,
    `${STATE_OPEN}${Buffer.from(JSON.stringify(rounds)).toString('base64')}${STATE_CLOSE}`,
  ];
  return lines.join('\n');
}

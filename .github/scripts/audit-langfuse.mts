// Sends one Langfuse trace for an audit autofix or repair run. Optional and never fatal: it skips
// without both keys and only warns when Langfuse rejects the trace.
//   node .github/scripts/audit-langfuse.mts --workflow <name> --outcome <name> [--run-json <claude-run.json>]
// Keys: AI_ANALYZER_LANGFUSE_PUBLIC_KEY and AI_ANALYZER_LANGFUSE_SECRET_KEY (the analyzer's project and host).
import { existsSync, readFileSync } from 'node:fs';
import { argValue } from './shared/cli.mts';
import {
  buildLangfuseBatch,
  parseClaudeRun,
} from './shared/audit-langfuse.mts';

// The host is fixed so a stray variable cannot send keys elsewhere; it is the one the analyzer uses.
const HOST = 'https://langfuse.svc.consensys.info';

async function main(): Promise<void> {
  const publicKey = process.env.AI_ANALYZER_LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.AI_ANALYZER_LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    console.log('Langfuse keys are not set; no trace sent.');
    return;
  }
  const runJson = argValue('--run-json');
  const text =
    runJson && existsSync(runJson) ? readFileSync(runJson, 'utf8').trim() : '';
  if (!text) {
    console.log('The agent did not run; no trace sent.');
    return;
  }
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const body = buildLangfuseBatch({
    workflow: argValue('--workflow') ?? 'audit-autofix',
    outcome: argValue('--outcome') ?? 'unknown',
    runId: GITHUB_RUN_ID ?? 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
    repository: GITHUB_REPOSITORY ?? '',
    model: process.env.MODEL ?? 'unknown',
    run: parseClaudeRun(JSON.parse(text) as Record<string, unknown>),
  });
  const response = await fetch(`${HOST}/api/public/ingestion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as {
    successes?: unknown[];
    errors?: unknown[];
  };
  const accepted = result.successes?.length ?? 0;
  const rejected = result.errors?.length ?? 0;
  console.log(
    `Langfuse answered ${response.status}: ${accepted} event(s) accepted, ${rejected} rejected.`,
  );
  if (!response.ok || rejected > 0) {
    console.log(
      `::warning::Langfuse did not accept the trace (HTTP ${response.status}).`,
    );
  }
}

// Node's fetch only says "fetch failed"; the reason (DNS, refused, timeout) is in the cause.
function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { cause } = error;
  const code =
    cause instanceof Error
      ? `${(cause as NodeJS.ErrnoException).code ?? ''} ${cause.message}`.trim()
      : '';
  return code ? `${error.message} (${code})` : error.message;
}

main().catch((error: unknown) => {
  console.log(`::warning::Langfuse trace failed: ${describe(error)}`);
});

// Posts or updates the audit repair status comment on the PR of an audit-fix branch.
//   node .github/scripts/audit-repair-report.mts --repo <owner/repo> --branch <audit-fix/...>
//     --run-id <id> --run-url <url> --repairs <n> --cap <n> --outcome <name> [--sha <sha>]
//     [--in-dir .tmp/report-in] [--dry-run]
// A dry run only prints the comment. Reads <in-dir>/audit-repair/plan.json and claude-run.json from the audit-repair artifact when present.
import { existsSync, readFileSync } from 'node:fs';
import { argValue } from './shared/cli.mts';
import { ghApi } from './shared/gh-api.mts';
import {
  buildReport,
  parseAutofixCost,
  parseState,
  REPORT_MARKER,
} from './shared/audit-repair-report.mts';

function required(name: string): string {
  const value = argValue(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function readJson<Shape>(path: string): Shape | undefined {
  // A step that died mid-write leaves an empty file, so treat it as missing.
  if (!existsSync(path)) {
    return undefined;
  }
  const text = readFileSync(path, 'utf8').trim();
  return text ? (JSON.parse(text) as Shape) : undefined;
}

const repo = required('--repo');
const branch = required('--branch');
const dir = `${argValue('--in-dir') ?? '.tmp/report-in'}/audit-repair`;
const plan = readJson<{
  plan: { action: string; steps: string[]; reason: string };
}>(`${dir}/plan.json`)?.plan;
const { total_cost_usd: cost } =
  readJson<Record<string, number>>(`${dir}/claude-run.json`) ?? {};

// The `head=` filter returned nothing for a branch name with a slash, so filter the list.
const pr = ghApi(`repos/${repo}/pulls?state=open&per_page=100`, {
  paginate: true,
  jq: `.[] | select(.head.ref == "${branch}") | {number, body} | tojson`,
})
  .split('\n')
  .filter(Boolean)
  .map(
    (line) => JSON.parse(line) as { number: number; body: string | null },
  )[0];
const prNumber = pr ? String(pr.number) : '';
const comment = prNumber
  ? ghApi(`repos/${repo}/issues/${prNumber}/comments`, {
      paginate: true,
      jq: `.[] | select(.body | contains("${REPORT_MARKER}")) | {id, body} | tojson`,
    })
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; body: string })[0]
  : undefined;

const reportFile = `${argValue('--in-dir') ?? '.tmp/report-in'}/audit-autofix/repair-report.md`;
const dryRun = process.argv.includes('--dry-run');
const body = buildReport({
  plan,
  outcome: required('--outcome'),
  sha: argValue('--sha'),
  repairsSoFar: Number(required('--repairs')),
  cap: Number(required('--cap')),
  costUsd: cost,
  runId: required('--run-id'),
  runUrl: required('--run-url'),
  previous: parseState(comment?.body),
  dryRun,
  agentReport: existsSync(reportFile)
    ? readFileSync(reportFile, 'utf8')
    : undefined,
  autofixCostUsd: parseAutofixCost(pr?.body ?? undefined),
});

if (dryRun) {
  console.log(body);
} else if (!prNumber) {
  console.log(
    `::warning::No open PR for ${branch}; the status comment is only printed.`,
  );
  console.log(body);
} else if (comment) {
  ghApi(`repos/${repo}/issues/comments/${comment.id}`, {
    method: 'PATCH',
    body: { body },
  });
  console.log(`Updated comment ${comment.id} on PR #${prNumber}.`);
} else {
  ghApi(`repos/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: { body },
  });
  console.log(`Commented on PR #${prNumber}.`);
}

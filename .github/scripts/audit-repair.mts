// Reads a failed CI run for the audit repair job.
//
// plan: prints what the repair job would do about it (see `decideRepair`). Read-only, so it can
//   be pointed at any run, including one on another branch.
//   node .github/scripts/audit-repair.mts plan --run-id <id> --repo <owner/repo>
//     [--attempt 1] [--repairs 0] [--cap 3] [--previous-signature <text>]
//
// prepare: writes the inputs of the LLM repair prompt (failure.json, failure.log, rows.md) from a
//   plan.json, plus the base files and targets.txt the churn guard needs, next to the out dir.
//   node .github/scripts/audit-repair.mts prepare --plan <plan.json> --repo <owner/repo>
//     --base-package <file> --base-lock <file> [--out-dir .tmp/audit-autofix/repair]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argValue } from './shared/cli.mts';
import { ghApi } from './shared/gh-api.mts';
import {
  classifyJob,
  decideRepair,
  LOG_CLASSIFIED_JOB,
  type FailedJob,
  type FailureKind,
  type RepairPlan,
} from './shared/audit-repair.mts';
import {
  logExcerpt,
  packageJsonChanges,
  renderRows,
} from './shared/audit-repair-inputs.mts';
import { computeChurn, parseLockfile } from './shared/lockfile-churn.mts';

type ApiJob = {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
};

function failedJobs(repo: string, runId: string, attempt: string): FailedJob[] {
  const lines = ghApi(
    `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    { paginate: true, jq: '.jobs[]|tojson' },
  )
    .split('\n')
    .filter(Boolean);
  return lines
    .map((line) => JSON.parse(line) as ApiJob)
    .filter((job) => job.conclusion === 'failure')
    .map((job) => ({
      id: job.id,
      name: job.name,
      failedSteps: (job.steps ?? [])
        .filter((step) => step.conclusion === 'failure')
        .map((step) => step.name),
    }))
    .map((job) => ({
      ...job,
      log: LOG_CLASSIFIED_JOB.test(job.name) ? fetchLog(repo, job) : undefined,
    }));
}

function fetchLog(repo: string, job: FailedJob): string | undefined {
  const path = `repos/${repo}/actions/jobs/${job.id}/logs`;
  try {
    try {
      return ghApi(path, { allowEscapeSequences: true });
    } catch {
      // An older gh does not know the flag.
      return ghApi(path);
    }
  } catch (error) {
    // Without the log the job stays in its plain class.
    console.error(
      `::warning::No log for ${job.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function required(name: string): string {
  const value = argValue(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function plan(): void {
  const repo = required('--repo');
  const runAttempt = argValue('--attempt') ?? '1';
  const failures = failedJobs(repo, required('--run-id'), runAttempt);
  const result = decideRepair({
    failures,
    repairsSoFar: Number(argValue('--repairs') ?? 0),
    cap: Number(argValue('--cap') ?? 3),
    previousSignature: argValue('--previous-signature'),
    runAttempt: Number(runAttempt),
  });

  console.log(JSON.stringify({ failures, plan: result }, null, 2));
}

// One job per class, most specific first, so the log stays short.
const LOG_PRIORITY: FailureKind[] = [
  'lint-heap',
  'lint',
  'depcheck',
  'build',
  'unit-test',
  'e2e',
];

function prepare(): void {
  const repo = required('--repo');
  const outDir = argValue('--out-dir') ?? '.tmp/audit-autofix/repair';
  const agentDir = dirname(outDir);
  const { failures, plan: repairPlan } = JSON.parse(
    readFileSync(required('--plan'), 'utf8'),
  ) as { failures: FailedJob[]; plan: RepairPlan };
  mkdirSync(outDir, { recursive: true });

  const classified = failures.map((job) => ({ job, kind: classifyJob(job) }));
  const chosen = LOG_PRIORITY.flatMap((kind) => {
    const match = classified.find((entry) => entry.kind === kind);
    return match ? [match] : [];
  });
  const logs = chosen.map(({ job, kind }) => {
    const log = job.log ?? fetchLog(repo, job) ?? '(log unavailable)';
    return `== ${job.name} (${kind}; failed step: ${job.failedSteps.join(', ')}) ==\n${logExcerpt(log)}`;
  });

  writeFileSync(
    `${outDir}/failure.json`,
    JSON.stringify(
      {
        action: repairPlan.action,
        reason: repairPlan.reason,
        signatureHash: repairPlan.signatureHash,
        kinds: [...new Set(classified.map(({ kind }) => kind))].filter(
          (kind) => kind !== 'cascade',
        ),
        jobs: classified
          .filter(({ kind }) => kind !== 'cascade')
          .map(({ job, kind }) => ({
            name: job.name,
            kind,
            failedSteps: job.failedSteps,
          })),
      },
      null,
      2,
    ),
  );
  writeFileSync(`${outDir}/failure.log`, `${logs.join('\n\n')}\n`);

  const basePackage = required('--base-package');
  const baseLock = required('--base-lock');
  const manifestChanges = packageJsonChanges(
    JSON.parse(readFileSync(basePackage, 'utf8')),
    JSON.parse(readFileSync('package.json', 'utf8')),
  );
  const churn = computeChurn({
    before: parseLockfile(readFileSync(baseLock, 'utf8')),
    after: parseLockfile(readFileSync('yarn.lock', 'utf8')),
    targets: new Set(),
    rootDependencies: {},
  });
  writeFileSync(`${outDir}/rows.md`, renderRows(manifestChanges, churn));

  // The churn guard in the prompt reads these two base files and the target list.
  copyFileSync(baseLock, `${agentDir}/yarn.base.lock`);
  copyFileSync(basePackage, `${agentDir}/package.base.json`);
  const targets = manifestChanges
    .filter(({ section }) => section !== 'resolutions')
    .map(({ name }) => name);
  writeFileSync(`${agentDir}/targets.txt`, `${targets.join('\n')}\n`);
  console.log(
    `Wrote ${outDir}: ${chosen.length} log excerpts, ${manifestChanges.length} package.json changes, ${churn.length} lockfile packages.`,
  );
}

const command = process.argv[2];
if (command === 'plan') {
  plan();
} else if (command === 'prepare') {
  prepare();
} else {
  throw new Error('Usage: audit-repair.mts <plan|prepare> [options]');
}

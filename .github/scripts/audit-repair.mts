// Reads a failed CI run and prints what the repair job would do about it (see `decideRepair`).
// Read-only: it changes nothing, so it can be pointed at any run, including one on another branch.
//
// Usage: node .github/scripts/audit-repair.mts plan --run-id <id> --repo <owner/repo>
//          [--attempt 1] [--repairs 0] [--cap 3] [--previous-signature <text>]
import { argValue } from './shared/cli.mts';
import { ghApi } from './shared/gh-api.mts';
import {
  decideRepair,
  LOG_CLASSIFIED_JOB,
  type FailedJob,
} from './shared/audit-repair.mts';

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
    .map((job) => ({ ...job, log: jobLog(repo, job) }));
}

function jobLog(repo: string, job: FailedJob): string | undefined {
  if (!LOG_CLASSIFIED_JOB.test(job.name)) {
    return undefined;
  }
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

const [command] = process.argv.slice(2);
const runId = argValue('--run-id');
const repo = argValue('--repo');
if (command !== 'plan' || !runId || !repo) {
  throw new Error('Usage: audit-repair.mts plan --run-id <id> --repo <o/r>');
}

const runAttempt = argValue('--attempt') ?? '1';
const failures = failedJobs(repo, runId, runAttempt);
const plan = decideRepair({
  failures,
  repairsSoFar: Number(argValue('--repairs') ?? 0),
  cap: Number(argValue('--cap') ?? 3),
  previousSignature: argValue('--previous-signature'),
  runAttempt: Number(runAttempt),
});

console.log(JSON.stringify({ failures, plan }, null, 2));

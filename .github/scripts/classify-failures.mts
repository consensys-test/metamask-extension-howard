/**
 * classify-failures.mts
 *
 * Analyzes failed jobs in a GitHub Actions workflow run and classifies each
 * failure (jobRetryable) based on job name patterns and transient error
 * detection. Derives an overall is-retryable decision from individual results.
 *
 * Uses the `gh` CLI for GitHub API calls — no workspace dependencies required.
 * The workflow installs @sentry/node separately for optional logging.
 * This lets the workflow use a sparse checkout without `yarn install`.
 *
 * Usage (CLI):
 *   node .github/scripts/classify-failures.mts <run-id> [--repo owner/repo]
 *
 * Usage (GitHub Actions — via env vars):
 *   GITHUB_TOKEN=... MAIN_RUN_ID=... REPO=... node .github/scripts/classify-failures.mts
 *
 * CLI arguments take precedence over environment variables.
 * GITHUB_TOKEN (or GH_TOKEN) is always read from the environment.
 *
 * Environment variables (set by the workflow in CI):
 *   GITHUB_OUTPUT            — Path to GitHub Actions output file
 *   GITHUB_STEP_SUMMARY      — Path to GitHub Actions step summary file
 *   HEAD_SHA                 — Commit SHA of the triggering run
 *   HEAD_BRANCH              — Branch name of the triggering run
 *   PR_NUMBER_FROM_EVENT      — PR number (from workflow_run.pull_requests[0];
 *                               empty for merge_group/push events)
 *   RUN_ATTEMPT              — Attempt number of the triggering run
 *   VERSION                  — Extension version (from package.json via curl)
 *   WORKFLOW_EVENT           — Triggering event type (e.g. merge_group, push)
 *   CI                       — Enables Check Run creation when 'true'
 *   CHECK_RUN_TOKEN          — Token for Check Run creation (fork workaround)
 *   SENTRY_DSN_PERFORMANCE   — Sentry DSN; enables structured log delivery
 *
 * Outputs (to $GITHUB_OUTPUT):
 *   is-retryable=true|false    — whether all failures are retryable
 *   has-retry-label=true|false — whether the originating PR has retry-ci
 *   will-retry=true|false      — is-retryable AND has-retry-label
 *   pr-number=<N>|""           — originating PR number (empty for push)
 *
 * Also writes a markdown report to $GITHUB_STEP_SUMMARY and optionally:
 *   - Creates a "Main CI Failure Triage" Check Run (when CI=true)
 *   - Sends a structured log to Sentry (when SENTRY_DSN_PERFORMANCE is set)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { getGitHubToken } from './github-token.mts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
}

interface Annotation {
  message?: string;
  title?: string;
}

type Category =
  | 'alwaysRetryable'
  | 'retryableOnTransientError'
  | 'usuallyNotFlaky'
  | 'optional';

interface JobClassification {
  jobName: string;
  jobId: number;
  category: Category;
  jobRetryable: boolean;
  reason: string;
  errorSnippet?: string;
  unmatched?: boolean;
}

interface CategoryConfig {
  patterns: string[];
  transientErrorPatterns?: string[];
}

interface RetryConfig {
  jobClassification: Record<Category, CategoryConfig>;
  blockerPatterns: string[];
  transientErrorPatterns: string[];
  defaults: { unmatchedCategory: Category };
}

// ---------------------------------------------------------------------------
// CLI + Environment
// ---------------------------------------------------------------------------

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', short: 'r' },
    attempt: { type: 'string', short: 'a' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (flags.help) {
  console.log(
    `Usage: node classify-failures.mts <run-id> [--repo owner/repo] [--attempt N]\n\n` +
      `  <run-id>    Workflow run ID (or set MAIN_RUN_ID env var)\n` +
      `  --repo      Repository in owner/repo format (default: REPO env or MetaMask/metamask-extension)\n` +
      `  --attempt   Run attempt number (default: latest)\n` +
      `\nGITHUB_TOKEN or GH_TOKEN must be set in the environment.`,
  );
  process.exit(0);
}

const GITHUB_TOKEN = getGitHubToken();
const MAIN_RUN_ID = positionals[0] || process.env.MAIN_RUN_ID || '';
const REPO = flags.repo || process.env.REPO || 'MetaMask/metamask-extension';
const ATTEMPT = flags.attempt || process.env.RUN_ATTEMPT || '';
const WORKFLOW_EVENT = process.env.WORKFLOW_EVENT ?? '';
const HEAD_BRANCH = process.env.HEAD_BRANCH ?? '';
const PR_NUMBER_FROM_EVENT = process.env.PR_NUMBER_FROM_EVENT ?? '';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT ?? '';
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY ?? '';

if (!MAIN_RUN_ID) {
  console.error(
    'No run ID provided. Pass it as the first argument or set MAIN_RUN_ID.',
  );
  process.exit(1);
}

const [owner, repo] = REPO.split('/');
const repoApi = `/repos/${owner}/${repo}`;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Strip full-line // comments and trailing commas from JSONC for JSON.parse().
 * This is a lightweight approach that does NOT handle // inside string values.
 * Safe for our config file which has no URLs or // in values.
 */
function stripJsonComments(jsonc: string): string {
  return jsonc
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,\s*([\]}])/g, '$1');
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(scriptDir, '..', 'rules', 'retry-config.jsonc');
const config: RetryConfig = JSON.parse(
  stripJsonComments(readFileSync(configPath, 'utf8')),
);

const categoryOrder: Category[] = [
  'alwaysRetryable',
  'retryableOnTransientError',
  'usuallyNotFlaky',
  'optional',
];

const compiledPatterns = Object.fromEntries(
  categoryOrder.map((cat) => [
    cat,
    config.jobClassification[cat].patterns.map((p) => new RegExp(p, 'i')),
  ]),
) as Record<Category, RegExp[]>;
const transientErrorRegexes = config.transientErrorPatterns.map(
  (p) => new RegExp(p, 'i'),
);

const categoryTransientRegexes: Partial<Record<Category, RegExp[]>> = {};
for (const cat of Object.keys(config.jobClassification) as Category[]) {
  const extra = config.jobClassification[cat].transientErrorPatterns;
  if (extra?.length) {
    categoryTransientRegexes[cat] = extra.map((p) => new RegExp(p, 'i'));
  }
}

const blockerRegexes = config.blockerPatterns.map((p) => new RegExp(p, 'i'));

// ---------------------------------------------------------------------------
// GitHub API helpers (gh CLI — no npm dependencies)
// ---------------------------------------------------------------------------

const ghEnv = { ...process.env, GH_TOKEN: GITHUB_TOKEN };

/** Call a GitHub REST API endpoint via `gh api`. Supports optional POST body and token override. */
function ghApi(
  path: string,
  opts?: {
    paginate?: boolean;
    method?: string;
    body?: Record<string, unknown>;
    token?: string;
  },
): string {
  const args = ['api', path];
  if (opts?.paginate) args.push('--paginate');
  if (opts?.method) args.push('--method', opts.method);
  if (opts?.body) args.push('--input', '-');
  const env = opts?.token ? { ...process.env, GH_TOKEN: opts.token } : ghEnv;
  return execFileSync('gh', args, {
    encoding: 'utf8',
    ...(opts?.body ? { input: JSON.stringify(opts.body) } : {}),
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
}

function getRunHeadSha(): string {
  if (process.env.HEAD_SHA) return process.env.HEAD_SHA;
  const run = JSON.parse(ghApi(`${repoApi}/actions/runs/${MAIN_RUN_ID}`));
  return run.head_sha;
}

function getFailedJobs(): Job[] {
  const jobsPath = ATTEMPT
    ? `${repoApi}/actions/runs/${MAIN_RUN_ID}/attempts/${ATTEMPT}/jobs?per_page=100`
    : `${repoApi}/actions/runs/${MAIN_RUN_ID}/jobs?per_page=100`;
  const response = JSON.parse(ghApi(jobsPath, { paginate: true }));
  return (response.jobs as Job[]).filter((j) => j.conclusion === 'failure');
}

function getAnnotations(jobId: number): Annotation[] {
  try {
    return JSON.parse(
      ghApi(`${repoApi}/check-runs/${jobId}/annotations`),
    ) as Annotation[];
  } catch {
    return [];
  }
}

const LOG_TAIL_LINES = 500;

function getJobLogs(jobId: number): string {
  try {
    const full = ghApi(`${repoApi}/actions/jobs/${jobId}/logs`);
    // Only search the tail — error summaries appear at the end and this
    // avoids false positives from earlier benign output.
    const lines = full.split('\n');
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

function matchCategory(jobName: string): {
  category: Category;
  unmatched: boolean;
} {
  for (const cat of categoryOrder) {
    for (const re of compiledPatterns[cat]) {
      if (re.test(jobName)) return { category: cat, unmatched: false };
    }
  }
  return { category: config.defaults.unmatchedCategory, unmatched: true };
}

function findTransientError(
  text: string,
  category?: Category,
): string | undefined {
  const regexes = [
    ...transientErrorRegexes,
    ...(category ? (categoryTransientRegexes[category] ?? []) : []),
  ];
  for (const re of regexes) {
    const match = re.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function classifyJob(job: Job): JobClassification {
  const jobName = job.name;
  const jobId = job.id;
  const { category, unmatched } = matchCategory(jobName);

  if (unmatched) {
    console.warn(
      `  ⚠️  "${jobName}" did not match any pattern — using default category '${category}'`,
    );
  }

  if (category === 'alwaysRetryable') {
    return {
      jobName,
      jobId,
      category,
      jobRetryable: true,
      reason: 'Job is in the always-retryable category',
      unmatched,
    };
  }

  if (category === 'optional') {
    return {
      jobName,
      jobId,
      category,
      jobRetryable: false,
      reason: 'Optional job — no retry needed',
      unmatched,
    };
  }

  // retryableOnTransientError / usuallyNotFlaky: check annotations, then logs
  const annotations = getAnnotations(jobId);
  const annotationText = annotations
    .map((a) => `${a.message ?? ''} ${a.title ?? ''}`)
    .join('\n');

  let transientMatch = findTransientError(annotationText, category);
  if (transientMatch) {
    return {
      jobName,
      jobId,
      category,
      jobRetryable: true,
      reason: `Transient error in annotations: ${transientMatch}`,
      errorSnippet: transientMatch,
      unmatched,
    };
  }

  // Fall back to log download
  console.log(`  Downloading logs for ${jobName} (${jobId})...`);
  const logs = getJobLogs(jobId);
  if (logs) {
    transientMatch = findTransientError(logs, category);
    if (transientMatch) {
      return {
        jobName,
        jobId,
        category,
        jobRetryable: true,
        reason: `Transient error in logs: ${transientMatch}`,
        errorSnippet: transientMatch,
        unmatched,
      };
    }
  }

  return {
    jobName,
    jobId,
    category,
    jobRetryable: false,
    reason: 'No transient error pattern detected',
    unmatched,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Classifying failures for run ${MAIN_RUN_ID}...`);

const failedJobs = getFailedJobs();

if (failedJobs.length === 0) {
  console.log('No failed jobs found.');
  if (GITHUB_OUTPUT) {
    appendFileSync(
      GITHUB_OUTPUT,
      'is-retryable=false\nhas-retry-label=false\nwill-retry=false\npr-number=\n',
    );
  }
  process.exit(0);
}

console.log(`Found ${failedJobs.length} failed job(s):\n`);

// Partition into blockers and non-blockers. If any blocker fails
// non-transiently, stop early and tag all remaining jobs as cascade.
const isBlocker = (name: string) => blockerRegexes.some((re) => re.test(name));
const blockerJobs = failedJobs.filter((j) => isBlocker(j.name));
const otherJobs = failedJobs.filter((j) => !isBlocker(j.name));

const classifications: JobClassification[] = [];
let blockedBy: string | undefined;

// Classify blockers first.
for (const job of blockerJobs) {
  console.log(`  Classifying (blocker): ${job.name}`);
  const result = classifyJob(job);
  classifications.push(result);
  console.log(
    `    → ${result.jobRetryable ? '✅ retryable' : '❌ non-retryable'}: ${result.reason}`,
  );
  if (!result.jobRetryable) {
    blockedBy = job.name;
    break; // No point checking further
  }
}

function tagCascade(jobs: Job[], jobRetryable: boolean, reason: string): void {
  for (const job of jobs) {
    const { category, unmatched } = matchCategory(job.name);
    classifications.push({
      jobName: job.name,
      jobId: job.id,
      category,
      jobRetryable,
      reason,
      unmatched,
    });
  }
}

if (blockedBy) {
  console.log(
    `\n  ⛔ Blocker "${blockedBy}" failed non-transiently. Skipping remaining jobs.\n`,
  );
  tagCascade(otherJobs, false, `Cascade — blocked by ${blockedBy}`);
} else if (blockerJobs.length > 0) {
  const blockerNames = blockerJobs.map((j) => j.name).join(', ');
  console.log(
    `\n  ♻️  Blocker(s) retryable — tagging ${otherJobs.length} downstream job(s) as cascade.\n`,
  );
  tagCascade(
    otherJobs,
    true,
    `Cascade — will resolve when blocker retries (${blockerNames})`,
  );
} else {
  // No blocker failures — classify each job individually.
  for (const job of otherJobs) {
    console.log(`  Classifying: ${job.name}`);
    const result = classifyJob(job);
    classifications.push(result);
    console.log(
      `    → ${result.jobRetryable ? '✅ retryable' : '❌ non-retryable'}: ${result.reason}`,
    );
  }
}

// Optional failures don't influence the retry decision.
const nonOptional = classifications.filter((c) => c.category !== 'optional');
const isRetryable =
  nonOptional.length > 0 && nonOptional.every((c) => c.jobRetryable);
console.log(`\nDecision: is-retryable=${isRetryable}`);

// ---------------------------------------------------------------------------
// Resolve originating PR and check for retry-ci label
// ---------------------------------------------------------------------------

function resolvePrNumber(): string {
  if (WORKFLOW_EVENT === 'pull_request' && PR_NUMBER_FROM_EVENT) {
    return PR_NUMBER_FROM_EVENT;
  }
  const match = HEAD_BRANCH.match(/gh-readonly-queue\/[^/]+\/pr-(\d+)-/);
  if (WORKFLOW_EVENT === 'merge_group' && match) {
    return match[1];
  }
  return '';
}

function checkRetryLabel(prNum: string): boolean {
  if (!prNum) return false;
  try {
    const labels = ghApi(`${repoApi}/issues/${prNum}/labels`);
    return (JSON.parse(labels) as Array<{ name: string }>).some(
      (l) => l.name === 'retry-ci',
    );
  } catch {
    console.warn(`Could not check labels on PR #${prNum}`);
    return false;
  }
}

const prNumber = resolvePrNumber();
const hasRetryLabel = checkRetryLabel(prNumber);
const willRetry = isRetryable && hasRetryLabel;
const hasPR = Boolean(prNumber);

// The retry decision depends on three independent facts:
//
//   isRetryable    — did classification determine all failures are retryable?
//   hasPR          — is there an originating PR? (false for push events)
//   hasRetryLabel  — does that PR have the `retry-ci` label?
//
// A retry only happens when ALL THREE are true (will-retry). The other
// combinations produce different reports and Sentry attributes so we can
// distinguish "retryable but nobody asked for a retry" from "someone asked
// but the failures aren't retryable."
//
// Note: hasRetryLabel implies hasPR (can't have a label without a PR),
// so *-false-true is impossible. The ?? fallback after the lookup is a
// defensive guard against that case to avoid a cryptic destructuring crash.
//
// The `key` is used in Sentry attributes; `label` is the human-readable
// line in the step summary and check run report.
const decisionTable: Record<string, { key: string; label: string }> = {
  'true-true-true': {
    key: 'will-retry',
    label: '♻️ Will retry (retry-ci label present)',
  },
  'true-true-false': {
    key: 'retryable-no-label',
    label: `⏸️ Retryable, but no retry-ci label on PR #${prNumber}`,
  },
  'true-false-false': {
    key: 'retryable-no-pr',
    label: '🔇 Retryable, but no originating PR (observation only)',
  },
  'false-true-true': {
    key: 'not-retryable-has-label',
    label: '⛔ Has retry-ci label but non-retryable failures',
  },
  'false-true-false': {
    key: 'not-retryable-no-label',
    label: `❌ Non-retryable (PR #${prNumber}, no retry-ci label)`,
  },
  'false-false-false': {
    key: 'not-retryable-no-pr',
    label: '❌ Non-retryable, no originating PR (observation only)',
  },
};
const { key: decision, label: decisionLabel } = decisionTable[
  `${isRetryable}-${hasPR}-${hasRetryLabel}`
] ?? { key: 'unknown', label: '❓ Unexpected state combination' };

console.log(
  prNumber
    ? `PR #${prNumber}: retry-ci label ${hasRetryLabel ? 'present' : 'absent'} → will-retry=${willRetry}`
    : `No originating PR for event '${WORKFLOW_EVENT}' → will-retry=false`,
);

// ---------------------------------------------------------------------------
// Write GITHUB_OUTPUT
// ---------------------------------------------------------------------------

if (GITHUB_OUTPUT) {
  appendFileSync(
    GITHUB_OUTPUT,
    [
      `is-retryable=${isRetryable}`,
      `has-retry-label=${hasRetryLabel}`,
      `will-retry=${willRetry}`,
      `pr-number=${prNumber}`,
    ].join('\n') + '\n',
  );
}

// ---------------------------------------------------------------------------
// Write GITHUB_STEP_SUMMARY (markdown report)
// ---------------------------------------------------------------------------

const mainRunUrl = `https://github.com/${owner}/${repo}/actions/runs/${MAIN_RUN_ID}`;
const triageRunUrl = `https://github.com/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

const reportLines = [
  `## Main CI Failure Triage`,
  ``,
  `**Run:** [${MAIN_RUN_ID}](${mainRunUrl})${ATTEMPT ? ` (attempt ${ATTEMPT})` : ''}`,
  `**Classification:** ${isRetryable ? '✅ All failures retryable' : '❌ Non-retryable failures detected'}`,
  `**Retry:** ${decisionLabel}`,
  `**Failed jobs:** ${failedJobs.length}`,
  ``,
  `| Job | Category | Job Retryable | Reason |`,
  `|-----|----------|---------------|--------|`,
  ...classifications.map(
    (c) =>
      `| ${c.jobName} | ${c.unmatched ? '⚠️ ' : ''}${c.category} | ${c.jobRetryable ? '✅' : '❌'} | ${c.reason} |`,
  ),
];

const unmatchedJobs = classifications.filter((c) => c.unmatched);
if (unmatchedJobs.length > 0) {
  reportLines.push(
    ``,
    `> ⚠️ **${unmatchedJobs.length} job(s) did not match any pattern** in retry-config.jsonc and used the default category \`${config.defaults.unmatchedCategory}\`:`,
    ...unmatchedJobs.map((c) => `> - ${c.jobName}`),
  );
}

const report = reportLines.join('\n');

if (GITHUB_STEP_SUMMARY) {
  appendFileSync(GITHUB_STEP_SUMMARY, report + '\n');
}

// Also print to console for non-GHA usage
console.log('\n' + report);

// ---------------------------------------------------------------------------
// Create Check Run on the triggering commit
//
// TODO: This is untestable in a fork repo, and we won't really know if this works
// until we merge it and see it run in the real repo.
// ---------------------------------------------------------------------------

if (process.env.CI === 'true') {
  try {
    const headSha = getRunHeadSha();
    const checkTitle = isRetryable
      ? 'All failures are retryable'
      : 'Non-retryable failures detected';

    // TODO: Remove CHECK_RUN_TOKEN workaround — fork-only. On the real repo,
    // remove the `token` option below so ghApi uses the default GH_TOKEN.
    //
    // Use CHECK_RUN_TOKEN if available — a PAT or GitHub App token with
    // checks:write that creates check runs in the correct check suite.
    // Falls back to GH_TOKEN (github.token) which works for non-PR events.
    const checkToken = process.env.CHECK_RUN_TOKEN || GITHUB_TOKEN;

    ghApi(`${repoApi}/check-runs`, {
      method: 'POST',
      body: {
        name: 'Main CI Failure Triage',
        head_sha: headSha,
        status: 'completed',
        conclusion: isRetryable ? 'neutral' : 'failure',
        output: {
          title: checkTitle,
          summary: report,
        },
      },
      token: checkToken,
    });
    console.log(`Created 'Main CI Failure Triage' check on ${headSha}`);
  } catch (err) {
    // Non-fatal: the check is informational. Log and continue.
    console.warn('Failed to create check run annotation:', err);
  }
}

// ---------------------------------------------------------------------------
// Send structured log to Sentry
// ---------------------------------------------------------------------------

const SENTRY_DSN = process.env.SENTRY_DSN_PERFORMANCE ?? '';

if (SENTRY_DSN) {
  try {
    // VERSION env var is set by the workflow (via curl + node -p) since
    // the sparse checkout doesn't include package.json.
    // Falls back to reading package.json from disk (for CLI use).
    let version = process.env.VERSION ?? '';
    if (!version) {
      try {
        const pkgPath = join(scriptDir, '..', '..', 'package.json');
        version = (
          JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
        ).version;
      } catch {
        version = 'unknown';
      }
    }

    // Use CJS require — ESM import('@sentry/node') breaks on some
    // workspace installs due to missing ESM export paths.
    const require = createRequire(import.meta.url);
    const Sentry = require('@sentry/node') as typeof import('@sentry/node');
    Sentry.init({
      dsn: SENTRY_DSN,
      enableLogs: true,
      release: `metamask-extension@${version}`,
    });

    const jobRetryableCount = classifications.filter((c) => c.jobRetryable).length;

    // Per-job structured attributes, capped to stay under Sentry's
    // 100-attribute limit (~16 top-level + 4 per job → max 20 jobs).
    const MAX_JOB_ATTRS = 20;
    const jobAttrs: Record<string, string | boolean> = {};
    const jobSlice = classifications.slice(0, MAX_JOB_ATTRS);
    for (let i = 0; i < jobSlice.length; i++) {
      const c = jobSlice[i];
      const p = `ci.retry.jobs.${i}`;
      jobAttrs[`${p}.name`] = c.jobName;
      jobAttrs[`${p}.category`] = c.category;
      jobAttrs[`${p}.jobRetryable`] = c.jobRetryable;
      jobAttrs[`${p}.reason`] = c.reason;
    }
    if (classifications.length > MAX_JOB_ATTRS) {
      jobAttrs['ci.retry.jobs.truncated'] = true;
    }

    Sentry.logger.info(`Main CI Failure Triage: ${decision}`, {
      'ci.branch': HEAD_BRANCH || '',
      'ci.commitHash': process.env.HEAD_SHA || '',
      'ci.prNumber': prNumber || 'none',
      'ci.repo': REPO,
      'ci.retry.decision': decision,
      'ci.retry.isRetryable': isRetryable,
      'ci.retry.hasRetryLabel': hasRetryLabel,
      'ci.retry.willRetry': willRetry,
      'ci.retry.runId': MAIN_RUN_ID,
      'ci.retry.attempt': ATTEMPT || 'unknown',
      'ci.retry.event': WORKFLOW_EVENT || '',
      'ci.retry.failedJobCount': failedJobs.length,
      'ci.retry.jobRetryableCount': jobRetryableCount,
      'ci.retry.jobNonRetryableCount': classifications.length - jobRetryableCount,
      'ci.retry.unmatchedJobCount': unmatchedJobs.length,
      'ci.retry.mainRunUrl': mainRunUrl,
      'ci.retry.triageRunUrl': triageRunUrl,
      'ci.retry.report': report,
      ...(blockedBy ? { 'ci.blockedBy': blockedBy } : {}),
      ...jobAttrs,
    });

    const flushed = await Sentry.flush(5000);
    if (flushed) {
      console.log('Sent classification log to Sentry');
    } else {
      console.warn('Sentry flush timed out');
    }
  } catch (err: unknown) {
    // Non-fatal: Sentry is optional. Fails gracefully when @sentry/node
    // is not installed (e.g. local CLI usage without `npm install @sentry/node`).
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      console.warn('Sentry skipped: @sentry/node not available');
    } else {
      console.warn('Failed to send classification log to Sentry:', err);
    }
  }
}

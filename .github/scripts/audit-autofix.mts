// Deterministic steps around the audit autofix agent.
//
//   select --issues <open|1,2> [--existing-pr-head audit-autofix] [--rolling-pr <number>]
//       Picks the open bot issues that still have advisories (from AUDIT_CURRENT_FILE), writes
//       .tmp/audit-autofix/issues.json and sets has-work for the workflow. Stops when an open
//       PR from the audit-autofix branch already exists, except the --rolling-pr one: a rolling run
//       adds to that PR and skips the issues its body already mentions.
//   gate
//       Fails when the agent changed anything outside the allowed paths; deletes the empty
//       dotfiles the sandbox leaves behind. Exit 3 means the agent changed nothing.
//   body --run-url <url>
//       Writes .tmp/audit-autofix/pr-body.md (a new PR) and pr-section.md (an addition to an
//       open PR) from the agent report and the command outputs.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { argValue } from './shared/cli.mts';
import { computeCloses } from './shared/audit-closes.mts';
import {
  buildPrBody,
  buildPrSection,
  classifyPaths,
  mentionedIssues,
  parsePorcelain,
  selectIssues,
  type SelectableIssue,
} from './shared/audit-autofix.mts';
import { AUDIT_CURRENT_FILE, readAdvisories } from './shared/audit-utils.mts';
import { ghApi } from './shared/gh-api.mts';
import { retry } from './shared/utils.mts';

const DIR = '.tmp/audit-autofix';
const EXIT_NO_CHANGES = 3;

function setOutput(name: string, value: string): void {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function select(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const repo = process.env.GITHUB_REPOSITORY ?? 'MetaMask/metamask-extension';
  const head = argValue('--existing-pr-head') ?? 'audit-autofix';

  // A single GitHub 5xx must not fail the run.
  const openPrs = (
    await retry(() =>
      ghApi(`/repos/${repo}/pulls?state=open&per_page=100`, {
        paginate: true,
        jq: `.[] | select(.head.ref == "${head}") | "#\\(.number) \\(.head.ref)"`,
      }),
    )
  )
    .split('\n')
    .filter(Boolean);
  // A rolling run adds to this one open PR; any other open audit PR still stops the run.
  const rollingPr = argValue('--rolling-pr');
  const blocking = rollingPr
    ? openPrs.filter((line) => !line.startsWith(`#${rollingPr} `))
    : openPrs;
  if (blocking.length > 0) {
    console.log(`An audit fix PR is already open: ${blocking.join(', ')}`);
    setOutput('has-work', 'false');
    setOutput('reason', 'open-pr');
    return;
  }

  // A fork test reads the real bot issues from the upstream repository.
  const issuesRepo = process.env.ISSUES_REPO || repo;
  const issues = (
    await retry(() =>
      ghApi(`/repos/${issuesRepo}/issues?state=open&per_page=100`, {
        paginate: true,
        jq: '.[] | select(.pull_request == null) | {number, title, body}',
      }),
    )
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SelectableIssue);
  const wanted = argValue('--issues') ?? 'open';
  const rolledIn = rollingPr
    ? mentionedIssues(
        await retry(() =>
          ghApi(`/repos/${repo}/pulls/${rollingPr}`, { jq: '.body // ""' }),
        ),
      )
    : new Set<number>();
  const selected = selectIssues(issues, wanted).filter(
    ({ number }) => wanted.trim() !== 'open' || !rolledIn.has(number),
  );

  const advisories = readAdvisories(AUDIT_CURRENT_FILE);
  if (advisories === null || advisories.length === 0) {
    throw new Error(`No advisories in ${AUDIT_CURRENT_FILE}`);
  }
  // Issues whose advisories are already gone on main need no fix, only closing.
  const decisions = computeCloses(selected, advisories);
  const work = selected.filter((issue) =>
    decisions.some(({ number, closes }) => number === issue.number && !closes),
  );
  console.log(
    `Selected ${selected.length} issues, ${work.length} still have advisories.`,
  );

  writeFileSync(`${DIR}/issues.json`, JSON.stringify(work, null, 2));
  setOutput('has-work', work.length > 0 ? 'true' : 'false');
  setOutput('reason', work.length > 0 ? 'issues' : 'nothing-to-fix');
}

function gate(): void {
  const status = execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
    encoding: 'utf8',
  });
  const { allowed, leftovers, forbidden } = classifyPaths(
    parsePorcelain(status),
  );

  for (const file of leftovers) {
    rmSync(file);
  }
  if (forbidden.length > 0) {
    console.error(
      `The agent changed paths that are not allowed:\n${forbidden.join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  if (allowed.length === 0) {
    console.error('The agent changed nothing.');
    process.exitCode = EXIT_NO_CHANGES;
    return;
  }
  console.log(`Allowed changes:\n${allowed.join('\n')}`);
}

function body(): void {
  const readJson = <Value,>(file: string): Value | undefined =>
    existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Value)
      : undefined;

  const { total_cost_usd: cost } =
    readJson<Record<string, number>>(`${DIR}/claude-run.json`) ?? {};
  const bypassed = readText(`${DIR}/bypassed.txt`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const input = {
    runUrl: argValue('--run-url') ?? '',
    closes: readText(`${DIR}/closes.md`),
    report: readText(`${DIR}/agent-report.md`),
    advisoriesBefore:
      readJson<unknown[]>(`${DIR}/audit-before.json`)?.length ?? 0,
    advisoriesAfter:
      readJson<unknown[]>(`${DIR}/audit-after.json`)?.length ?? 0,
    necessityLines: readText(`${DIR}/necessity.md`).split('\n').filter(Boolean),
    churnLines: readText(`${DIR}/churn.md`).split('\n').filter(Boolean),
    deadPinLines: readText(`${DIR}/dead-pins.md`).split('\n').filter(Boolean),
    ageGateBypassed: [...new Set(bypassed)],
    costUsd: cost,
  };
  const text = buildPrBody(input);
  writeFileSync(`${DIR}/pr-body.md`, text);
  writeFileSync(`${DIR}/pr-section.md`, buildPrSection(input));
  console.log(
    `Wrote ${DIR}/pr-body.md (${text.length} characters) and pr-section.md.`,
  );
}

const command = process.argv[2];
if (command === 'select') {
  await select();
} else if (command === 'gate') {
  gate();
} else if (command === 'body') {
  body();
} else {
  throw new Error('Usage: audit-autofix.mts <select|gate|body> [options]');
}

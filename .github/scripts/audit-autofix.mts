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
//   previous --pr <number>
//       For a rolling run: downloads the artifacts of the autofix runs named by the
//       Audit-Autofix trailers on the PR, and writes what the next steps need (the earlier report,
//       the first run's audit, the union of targets, the summed spend).
//   body --run-url <url>
//       Writes .tmp/audit-autofix/pr-body.md (the whole description, covering every round) and
//       pr-section.md (this run alone) from the agent report and the command outputs.
//   rolled-body --current <file>
//       Writes pr-body-rolled.md: the whole new description when nobody edited the PR body since
//       the last run, otherwise the current body plus this run's section.
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
  autofixRunIds,
  buildPrBody,
  buildPrSection,
  classifyPaths,
  mentionedIssues,
  missingEarlierItems,
  parsePorcelain,
  sameBody,
  selectIssues,
  type SelectableIssue,
} from './shared/audit-autofix.mts';
import { AUDIT_CURRENT_FILE, readAdvisories } from './shared/audit-utils.mts';
import { ghApi } from './shared/gh-api.mts';
import { retry } from './shared/utils.mts';

const DIR = '.tmp/audit-autofix';
// Outside DIR, so the earlier runs' files are not uploaded again with this run.
const PREVIOUS_DIR = '.tmp/audit-autofix-previous';
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

type PreviousRuns = {
  complete: boolean;
  runUrls: string[];
  costUsd: number;
  bypassed: string[];
};

function readLines(file: string): string[] {
  return readText(file)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Each run's artifact holds that run's files; the latest one already covers the earlier rounds.
async function previous(): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY ?? 'MetaMask/metamask-extension';
  const pr = argValue('--pr');
  if (!pr) {
    throw new Error('previous needs --pr <number>');
  }
  mkdirSync(DIR, { recursive: true });
  rmSync(PREVIOUS_DIR, { recursive: true, force: true });
  mkdirSync(PREVIOUS_DIR, { recursive: true });

  const messages = (
    await retry(() =>
      ghApi(`/repos/${repo}/pulls/${pr}/commits?per_page=100`, {
        paginate: true,
        jq: '.[] | .commit.message | @json',
      }),
    )
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string);
  const runIds = autofixRunIds(messages);

  const downloaded: string[] = [];
  for (const id of runIds) {
    try {
      execFileSync(
        'gh',
        [
          'run',
          'download',
          id,
          '--repo',
          repo,
          '-n',
          'audit-autofix',
          '-D',
          `${PREVIOUS_DIR}/${id}`,
        ],
        { stdio: 'inherit' },
      );
      downloaded.push(id);
    } catch {
      console.log(
        `::warning::The files of autofix run ${id} could not be downloaded.`,
      );
    }
  }
  const complete = runIds.length > 0 && downloaded.length === runIds.length;
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runDir = (id: string): string => `${PREVIOUS_DIR}/${id}`;

  const runs: PreviousRuns = {
    complete,
    runUrls: runIds.map((id) => `${serverUrl}/${repo}/actions/runs/${id}`),
    costUsd: downloaded.reduce((sum, id) => {
      const file = `${runDir(id)}/claude-run.json`;
      const { total_cost_usd: cost } = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>)
        : {};
      return sum + (cost ?? 0);
    }, 0),
    bypassed: [
      ...new Set(
        downloaded.flatMap((id) => readLines(`${runDir(id)}/bypassed.txt`)),
      ),
    ],
  };
  writeFileSync(`${PREVIOUS_DIR}/previous.json`, JSON.stringify(runs, null, 2));
  writeFileSync(
    `${PREVIOUS_DIR}/targets.txt`,
    [
      ...new Set(
        downloaded.flatMap((id) => readLines(`${runDir(id)}/targets.txt`)),
      ),
    ].join('\n'),
  );
  if (!complete) {
    console.log(
      `Earlier runs: ${runIds.length} named, ${downloaded.length} downloaded; the description will be appended to.`,
    );
    return;
  }
  const first = runIds[0];
  const last = runIds[runIds.length - 1];
  writeFileSync(
    `${PREVIOUS_DIR}/last-body.md`,
    readText(`${runDir(last)}/pr-body.md`),
  );
  writeFileSync(
    `${DIR}/previous-report.md`,
    readText(`${runDir(last)}/agent-report.md`),
  );
  writeFileSync(
    `${DIR}/audit-initial.json`,
    readText(`${runDir(first)}/audit-before.json`),
  );
  console.log(`Earlier runs: ${runIds.join(', ')}.`);
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

  const runUrl = argValue('--run-url') ?? '';
  const earlier = readJson<PreviousRuns>(`${PREVIOUS_DIR}/previous.json`);
  const rolled = earlier?.complete === true;
  const report = readText(`${DIR}/agent-report.md`);
  // The first run's audit is the state of main, so the description counts from there.
  const initialAudit = rolled
    ? readJson<unknown[]>(`${DIR}/audit-initial.json`)
    : undefined;

  const input = {
    runUrl,
    closes: readText(`${DIR}/closes.md`),
    report,
    advisoriesBefore:
      (initialAudit ?? readJson<unknown[]>(`${DIR}/audit-before.json`))
        ?.length ?? 0,
    advisoriesAfter:
      readJson<unknown[]>(`${DIR}/audit-after.json`)?.length ?? 0,
    necessityLines: readText(`${DIR}/necessity.md`).split('\n').filter(Boolean),
    churnLines: readText(`${DIR}/churn.md`).split('\n').filter(Boolean),
    deadPinLines: readText(`${DIR}/dead-pins.md`).split('\n').filter(Boolean),
    ageGateBypassed: [...new Set([...(earlier?.bypassed ?? []), ...bypassed])],
    costUsd: cost,
  };
  // This run alone, for appending when the whole description cannot be replaced.
  writeFileSync(
    `${DIR}/pr-section.md`,
    buildPrSection({ ...input, ageGateBypassed: [...new Set(bypassed)] }),
  );

  const missing = rolled
    ? missingEarlierItems(readText(`${DIR}/previous-report.md`), report)
    : [];
  const text = buildPrBody(
    rolled && earlier
      ? {
          ...input,
          runUrls: [...earlier.runUrls, runUrl],
          costUsd:
            cost === undefined && earlier.costUsd === 0
              ? undefined
              : earlier.costUsd + (cost ?? 0),
        }
      : input,
  );
  writeFileSync(`${DIR}/pr-body.md`, text);
  writeFileSync(
    `${DIR}/rolled.json`,
    JSON.stringify({ whole: rolled && missing.length === 0, missing }),
  );
  if (missing.length > 0) {
    console.log(
      `::warning::The merged report dropped earlier items: ${missing.join(', ')}.`,
    );
  }
  console.log(
    `Wrote ${DIR}/pr-body.md (${text.length} characters) and pr-section.md.`,
  );
}

// A person's edit to the body must survive, so the whole description replaces only the last generated one.
function rolledBody(): void {
  const currentFile = argValue('--current');
  if (!currentFile) {
    throw new Error('rolled-body needs --current <file>');
  }
  const current = readText(currentFile);
  const { whole } = existsSync(`${DIR}/rolled.json`)
    ? (JSON.parse(readText(`${DIR}/rolled.json`)) as { whole: boolean })
    : { whole: false };
  const unedited = sameBody(current, readText(`${PREVIOUS_DIR}/last-body.md`));
  const useWhole = whole && unedited;
  const text = useWhole
    ? readText(`${DIR}/pr-body.md`)
    : `${current.trimEnd()}\n\n---\n\n${readText(`${DIR}/pr-section.md`)}`;
  writeFileSync(`${DIR}/pr-body-rolled.md`, text);
  console.log(
    useWhole
      ? 'Replacing the description with one covering every round.'
      : `::warning::Appending this run to the description (${whole ? 'it was edited' : 'earlier rounds could not be merged'}).`,
  );
}

const command = process.argv[2];
if (command === 'select') {
  await select();
} else if (command === 'previous') {
  await previous();
} else if (command === 'gate') {
  gate();
} else if (command === 'body') {
  body();
} else if (command === 'rolled-body') {
  rolledBody();
} else {
  throw new Error(
    'Usage: audit-autofix.mts <select|previous|gate|body|rolled-body> [options]',
  );
}

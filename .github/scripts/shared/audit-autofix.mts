// Only these paths may change in an audit fix; anything else needs a human.
const ALLOWED_PATHS: RegExp[] = [
  /^package\.json$/u,
  /^yarn\.lock$/u,
  /^\.yarn\/patches\/.+/u,
  /^lavamoat\/webpack\/.+\/policy\.json$/u,
];

// Files the Claude Code sandbox creates (empty) in the repo root.
const SANDBOX_LEFTOVERS = new Set([
  '.bash_profile',
  '.bashrc',
  '.gitconfig',
  '.mcp.json',
  '.profile',
  '.ripgreprc',
  '.zprofile',
  '.zshrc',
]);

export type StatusEntry = { path: string; untracked: boolean };

export type PathClassification = {
  allowed: string[];
  /** Untracked sandbox dotfiles to delete before committing. */
  leftovers: string[];
  forbidden: string[];
};

/** Reads `git status --porcelain=v1 -uall`; a rename lists both sides. */
export function parsePorcelain(text: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.length < 4) {
      continue;
    }
    const untracked = line.startsWith('??');
    for (const path of line.slice(3).split(' -> ')) {
      entries.push({ path: path.replace(/^"(.*)"$/u, '$1'), untracked });
    }
  }
  return entries;
}

export function classifyPaths(entries: StatusEntry[]): PathClassification {
  const result: PathClassification = {
    allowed: [],
    leftovers: [],
    forbidden: [],
  };
  for (const { path, untracked } of entries) {
    if (untracked && SANDBOX_LEFTOVERS.has(path)) {
      result.leftovers.push(path);
    } else if (ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
      result.allowed.push(path);
    } else {
      result.forbidden.push(path);
    }
  }
  return result;
}

/** Agent text must not add its own issue-closing keywords; the gate's `Closes:` lines are the only ones. */
export function stripClosingKeywords(text: string): string {
  return text
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/^\s*[-*]?\s*(closes|close|closed|fixes|fix|fixed|resolves|resolve|resolved)\b[:\s]+\S*#\d+/iu.test(
          line,
        ),
    )
    .join('\n');
}

export type PrBodyInput = {
  runUrl: string;
  /** Every autofix run behind the PR, oldest first, when a rolling run rewrites the whole description. */
  runUrls?: string[];
  /** Output of `audit-closes` (`Closes: #N` lines and the not-closed notes). */
  closes: string;
  /** The agent's own explanation. */
  report: string;
  advisoriesBefore: number;
  advisoriesAfter: number;
  /** One line per added resolution, from `resolution-necessity`. */
  necessityLines: string[];
  /** Dead pins and unused patches the workflow removed, from `prune-dead-pins`. */
  deadPinLines: string[];
  /** Production packages that moved because a targeted package depends on them, from `lockfile-churn-guard`. */
  churnLines: string[];
  /** Packages whose age gate was bypassed. */
  ageGateBypassed: string[];
  costUsd: number | undefined;
};

function evidenceLines(input: PrBodyInput): string[] {
  return [
    `- Advisories on the branch: ${input.advisoriesBefore} before, ${input.advisoriesAfter} after (\`yarn npm audit --recursive\`).`,
    input.ageGateBypassed.length > 0
      ? `- Age gate (\`npmMinimalAgeGate\`) bypassed for: ${input.ageGateBypassed.join(', ')}.`
      : '- Age gate bypassed for: nothing.',
    ...(input.necessityLines.length > 0
      ? ['- Resolutions added, each tested by removing it:']
      : []),
    ...input.necessityLines.map((line) => `  ${line}`),
    ...(input.deadPinLines.length > 0
      ? ['- Cleaned up by the workflow (the lockfile is unchanged by this):']
      : []),
    ...input.deadPinLines.map((line) => `  ${line}`),
    ...(input.churnLines.length > 0
      ? [
          '- Production packages that moved with a fix (a targeted package depends on them):',
        ]
      : []),
    ...input.churnLines.map((line) => `  ${line}`),
    "- Not run by the workflow: unit and E2E tests, builds, and `yarn lavamoat:auto`. CI decides, and later steps apply CI's LavaMoat policy diff.",
  ];
}

// total_cost_usd is Claude Code's own price-table estimate, not gateway billing.
function spendLine(costUsd: number | undefined, runs = 1): string {
  if (costUsd === undefined) {
    return '**LLM spend:** not reported.';
  }
  const total = runs > 1 ? ` in total over ${runs} autofix runs` : '';
  return `**LLM spend:** approximately $${costUsd.toFixed(2)}${total} (estimated by Claude Code, not the billed amount).`;
}

export function buildPrBody(input: PrBodyInput): string {
  const evidence = evidenceLines(input);
  const runUrls = input.runUrls ?? [input.runUrl];
  const runs =
    runUrls.length > 1
      ? runUrls.map((url, index) => `[run ${index + 1}](${url})`).join(', ')
      : `[audit autofix workflow](${input.runUrl})`;

  return [
    '## **Description**',
    '',
    `This PR was prepared by the audit autofix workflow (${runs}), not by a person. It is a draft until a human has reviewed it.`,
    '',
    spendLine(input.costUsd, runUrls.length),
    '',
    stripClosingKeywords(input.report).trim(),
    '',
    '### Evidence from the workflow',
    '',
    ...evidence,
    '',
    '## **Changelog**',
    '',
    'CHANGELOG entry: null',
    '',
    '## **Related issues**',
    '',
    input.closes.trim(),
    '',
    '<!--',
    '## **Manual testing steps**',
    '## **Screenshots/Recordings**',
    '## **Pre-merge author checklist**',
    '## **Pre-merge reviewer checklist**',
    '-->',
    '',
  ].join('\n');
}

/** What a rolling run adds to the open PR's body: the facts of a new PR body under their own heading. */
export function buildPrSection(input: PrBodyInput): string {
  return [
    `### Added by the [audit autofix run](${input.runUrl})`,
    '',
    spendLine(input.costUsd),
    '',
    stripClosingKeywords(input.report).trim(),
    '',
    ...evidenceLines(input),
    '',
    input.closes.trim(),
    '',
  ].join('\n');
}

/** Issues a PR body already mentions (closed or left over); a rolling run does not retry them. */
export function mentionedIssues(body: string): Set<number> {
  return new Set(
    [...body.matchAll(/#(\d+)/gu)].map((match) => Number(match[1])),
  );
}

/** Run ids from the `Audit-Autofix: <run id>` trailers of a PR's commit messages, oldest first. */
export function autofixRunIds(messages: string[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const match of message.matchAll(/^Audit-Autofix:\s*(\d+)\s*$/gmu)) {
      if (!ids.includes(match[1])) {
        ids.push(match[1]);
      }
    }
  }
  return ids;
}

/** The packages a report names as list items (`- **pkg** ...`), at any depth. */
export function reportItems(report: string): string[] {
  return [...report.matchAll(/^\s*[-*]\s+\*\*([^*]+)\*\*/gmu)].map((match) =>
    match[1].trim(),
  );
}

/** Items the earlier rounds reported that a merged report no longer names. */
export function missingEarlierItems(
  earlierReport: string,
  mergedReport: string,
): string[] {
  const kept = new Set(reportItems(mergedReport));
  return reportItems(earlierReport).filter((item) => !kept.has(item));
}

/** GitHub may store the body with CRLF and trim it; compare without those. */
export function sameBody(left: string, right: string): boolean {
  const normalize = (text: string): string =>
    text.replace(/\r\n/gu, '\n').trim();
  return normalize(left) === normalize(right);
}

export type SelectableIssue = { number: number; title: string; body: string };

export const AUDIT_ISSUE_TITLE_PREFIX =
  'Yarn Audit: new or newly blocking advisories on main';

/** `open` selects every open bot issue; otherwise a comma-separated list of issue numbers. */
export function selectIssues(
  issues: SelectableIssue[],
  input: string,
): SelectableIssue[] {
  const audit = issues.filter(({ title }) =>
    title.startsWith(AUDIT_ISSUE_TITLE_PREFIX),
  );
  if (input.trim() === 'open') {
    return audit;
  }
  const wanted = new Set(
    input
      .split(',')
      .map((part) => Number(part.trim().replace(/^#/u, '')))
      .filter((number) => Number.isInteger(number) && number > 0),
  );
  return audit.filter(({ number }) => wanted.has(number));
}

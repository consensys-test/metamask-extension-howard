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
  /** Output of `audit-closes` (`Closes: #N` lines and the not-closed notes). */
  closes: string;
  /** The agent's own explanation. */
  report: string;
  advisoriesBefore: number;
  advisoriesAfter: number;
  /** One line per added resolution, from `resolution-necessity`. */
  necessityLines: string[];
  /** Production packages that moved because a targeted package depends on them, from `lockfile-churn-guard`. */
  churnLines: string[];
  /** Packages whose age gate was bypassed. */
  ageGateBypassed: string[];
  costUsd: number | undefined;
};

export function buildPrBody(input: PrBodyInput): string {
  const evidence = [
    `- Advisories on the branch: ${input.advisoriesBefore} before, ${input.advisoriesAfter} after (\`yarn npm audit --recursive\`).`,
    input.ageGateBypassed.length > 0
      ? `- Age gate (\`npmMinimalAgeGate\`) bypassed for: ${input.ageGateBypassed.join(', ')}.`
      : '- Age gate bypassed for: nothing.',
    input.costUsd === undefined
      ? '- LLM spend: not reported.'
      : `- LLM spend in this run: $${input.costUsd.toFixed(2)}.`,
    ...(input.necessityLines.length > 0
      ? ['- Resolutions added, each tested by removing it:']
      : []),
    ...input.necessityLines.map((line) => `  ${line}`),
    ...(input.churnLines.length > 0
      ? [
          '- Production packages that moved with a fix (a targeted package depends on them):',
        ]
      : []),
    ...input.churnLines.map((line) => `  ${line}`),
    "- Not run by the workflow: unit and E2E tests, builds, and `yarn lavamoat:auto`. CI decides, and later steps apply CI's LavaMoat policy diff.",
  ];

  return [
    '## **Description**',
    '',
    `This PR was prepared by the [audit autofix workflow](${input.runUrl}), not by a person. It is a draft until a human has reviewed it.`,
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

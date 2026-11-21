// Prints the `Closes:` lines for the open audit bot issues whose advisories are all gone.
//
// Usage: yarn tsx .github/scripts/audit-closes.mts [--advisories <file>] [--issues <file>]
//   --advisories  ParsedAdvisory[] JSON from the audit run on the branch (default: AUDIT_CURRENT_FILE)
//   --issues      JSON array of { number, body } instead of fetching open issues from GitHub
import { readFileSync } from 'node:fs';
import {
  computeCloses,
  formatClosesMarkdown,
  type IssueInput,
} from './shared/audit-closes.mts';
import { AUDIT_CURRENT_FILE, readAdvisories } from './shared/audit-utils.mts';
import { ghApi } from './shared/gh-api.mts';

const ISSUE_TITLE_PREFIX =
  'Yarn Audit: new or newly blocking advisories on main';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fetchOpenAuditIssues(): IssueInput[] {
  const repo = process.env.GITHUB_REPOSITORY ?? 'MetaMask/metamask-extension';
  const output = ghApi(`/repos/${repo}/issues?state=open&per_page=100`, {
    paginate: true,
    jq: `.[] | select(.pull_request == null) | select(.title | startswith("${ISSUE_TITLE_PREFIX}")) | {number, body}`,
  });
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IssueInput);
}

function main(): void {
  const advisoriesFile = argValue('--advisories') ?? AUDIT_CURRENT_FILE;
  const advisories = readAdvisories(advisoriesFile);
  // readAdvisories treats an empty file as "no advisories"; here that would close every issue.
  if (
    advisories === null ||
    readFileSync(advisoriesFile, 'utf8').trim() === ''
  ) {
    throw new Error(`Cannot read advisories from ${advisoriesFile}`);
  }

  const issuesFile = argValue('--issues');
  const issues = issuesFile
    ? (JSON.parse(readFileSync(issuesFile, 'utf8')) as IssueInput[])
    : fetchOpenAuditIssues();

  console.log(formatClosesMarkdown(computeCloses(issues, advisories)));
}

main();

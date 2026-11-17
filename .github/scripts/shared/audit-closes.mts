import { advisoryIdentityKey, type ParsedAdvisory } from './audit-utils.mts';

export type IssueAdvisoryRef = {
  key: string;
  moduleName: string;
  title: string;
  url: string;
};

export type IssueInput = { number: number; body: string };

export type CloseDecision = {
  number: number;
  closes: boolean;
  advisoryCount: number;
  /** One "package: GHSA url or title" line per advisory still reported. */
  remaining: string[];
};

// Matches `- **pkg** (severity[, scope]) — title`, the format written by yarn-audit-diff.mts.
const ENTRY_LINE = /^- \*\*(.+?)\*\* \([^)]*\) — (.+)$/u;
const URL_LINE = /^\s+(https?:\/\/\S+)\s*$/u;

/** Reads the advisory list a bot issue was opened with, ignoring the native audit tree. */
export function parseIssueAdvisories(body: string): IssueAdvisoryRef[] {
  const lines = body.split('<details>')[0].split(/\r?\n/u);
  const refs: IssueAdvisoryRef[] = [];

  lines.forEach((line, index) => {
    const match = ENTRY_LINE.exec(line);
    if (!match) {
      return;
    }
    const [, moduleName, title] = match;
    const url = URL_LINE.exec(lines[index + 1] ?? '')?.[1] ?? '';
    const key = advisoryIdentityKey({ id: null, moduleName, title, url });
    refs.push({ key, moduleName, title, url });
  });

  return refs;
}

/**
 * An issue closes only when it lists at least one advisory and none of them is
 * still reported. Matching is per advisory identity, never per package name.
 */
export function computeCloses(
  issues: IssueInput[],
  remainingAdvisories: ParsedAdvisory[],
): CloseDecision[] {
  const remainingKeys = new Set(remainingAdvisories.map(advisoryIdentityKey));

  return issues.map(({ number, body }) => {
    const refs = parseIssueAdvisories(body);
    const remaining = refs
      .filter((ref) => remainingKeys.has(ref.key))
      .map((ref) => `${ref.moduleName}: ${ref.url || ref.title}`);

    return {
      number,
      closes: refs.length > 0 && remaining.length === 0,
      advisoryCount: refs.length,
      remaining,
    };
  });
}

/** Markdown for the PR body: `Closes:` lines first, then why the other issues stay open. */
export function formatClosesMarkdown(decisions: CloseDecision[]): string {
  const closing = decisions.filter((decision) => decision.closes);
  const open = decisions.filter((decision) => !decision.closes);
  const out = closing.map((decision) => `Closes: #${decision.number}`);

  if (open.length > 0) {
    out.push('', 'Not closed:');
    for (const decision of open) {
      const why =
        decision.advisoryCount === 0
          ? 'no advisories could be read from the issue body'
          : `${decision.remaining.length} of ${decision.advisoryCount} still reported (${decision.remaining.join('; ')})`;
      out.push(`- #${decision.number}: ${why}`);
    }
  }

  return out.join('\n');
}

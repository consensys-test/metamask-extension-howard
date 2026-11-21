import { toolchainFamily } from './audit-consumers.mts';
import type { PackageChange } from './lockfile-churn.mts';

// Strongest evidence first: the first pattern that matches anywhere picks the line.
const CAUSE_PATTERNS = [
  /JavaScript heap out of memory|Reached heap limit/u,
  /FATAL ERROR/u,
  /##\[error\]/u,
  /\bFAIL\b/u,
  /\bError:/u,
];

const stripNoise = (line: string): string =>
  line
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /u, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/gu, '');

/**
 * About `size` lines of a job log around its first cause line. A log without
 * one gives its tail. Timestamps and colour codes are dropped.
 */
export function logExcerpt(log: string, size = 50): string {
  const lines = log.split('\n').map(stripNoise);
  const found = CAUSE_PATTERNS.map((pattern) =>
    lines.findIndex((line) => pattern.test(line)),
  ).find((index) => index >= 0);
  if (found === undefined) {
    return lines.slice(-size).join('\n');
  }
  const start = Math.max(0, found - Math.floor(size / 5));
  return lines.slice(start, start + size).join('\n');
}

const SECTIONS = ['dependencies', 'devDependencies', 'resolutions'] as const;

type Manifest = Partial<
  Record<(typeof SECTIONS)[number], Record<string, string>>
>;

/** One line per added, removed or repointed entry of the dependency sections. */
export function packageJsonChanges(
  base: Manifest,
  head: Manifest,
): { section: string; name: string; line: string }[] {
  const changes: { section: string; name: string; line: string }[] = [];
  for (const section of SECTIONS) {
    const before = base[section] ?? {};
    const after = head[section] ?? {};
    for (const name of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (before[name] === after[name]) {
        continue;
      }
      let detail = `${before[name]} -> ${after[name]}`;
      if (before[name] === undefined) {
        detail = `added ${after[name]}`;
      } else if (after[name] === undefined) {
        detail = `removed (was ${before[name]})`;
      }
      changes.push({
        section,
        name,
        line: `${section}: \`${name}\` ${detail}`,
      });
    }
  }
  return changes;
}

const OTHER_LIMIT = 40;

/** The branch diff, with lockfile changes grouped by toolchain family. */
export function renderRows(
  manifestChanges: { line: string }[],
  churn: PackageChange[],
): string {
  const families = new Map<string, PackageChange[]>();
  for (const change of churn) {
    const family = toolchainFamily(change.name) ?? 'other';
    families.set(family, [...(families.get(family) ?? []), change]);
  }
  const describe = (change: PackageChange): string =>
    `- \`${change.name}\`: ${change.before.join(', ') || '(new)'} -> ${change.after.join(', ') || '(removed)'}${change.majorJump ? ' (major jump)' : ''}`;

  const lines = [
    '# What the branch changed',
    '',
    'Attribute the failure to the toolchain family or package below that explains it. A family with many packages moving together is the usual cause of a lint, build or test-tool failure.',
    '',
    '## package.json',
    '',
    ...(manifestChanges.length > 0
      ? manifestChanges.map(({ line }) => `- ${line}`)
      : ['- no dependency changes']),
    '',
    '## Lockfile packages by family',
  ];
  // Named families first, `other` last and shortened.
  const ordered = [...families].sort(([a], [b]) => {
    if (a === 'other' || b === 'other') {
      return Number(a === 'other') - Number(b === 'other');
    }
    return a.localeCompare(b);
  });
  for (const [family, changes] of ordered) {
    const shown = family === 'other' ? changes.slice(0, OTHER_LIMIT) : changes;
    lines.push('', `### ${family} (${changes.length} packages)`, '');
    lines.push(...shown.map(describe));
    if (shown.length < changes.length) {
      lines.push(`- ... and ${changes.length - shown.length} more`);
    }
  }
  return `${lines.join('\n')}\n`;
}

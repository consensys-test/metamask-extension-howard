import semver from 'semver';
import type { LockEntry } from './lockfile-churn.mts';

const HOUR_MS = 3_600_000;

export type PackageVersion = {
  version: string;
  publishedAt: number;
  /** Ranges this version puts on the watched packages (dependencies and optionalDependencies). */
  ranges: Record<string, string>;
};

/** Stable versions of one package, ascending. */
export type PackageInfo = { versions: PackageVersion[] };

export type Consumer = {
  parent: string;
  parentVersion: string;
  /** Range the parent puts on the vulnerable package. */
  range: string;
  /** Version that range resolves to in the lockfile. */
  resolved: string;
};

export type Fix = {
  version: string;
  ageHours: number;
  /** True when the release is younger than the age gate, so Yarn silently skips it. */
  gated: boolean;
  /** Range the fixed release puts on the vulnerable package, or `none`. */
  requires: string;
};

export type Blocker = { name: string; version: string; range: string };

type Clock = { now: number; gateHours: number };

const stripNpm = (range: string): string => range.replace(/^npm:/u, '');

export function isVulnerable(version: string, vulnerable: string[]): boolean {
  return vulnerable.some((range) => {
    try {
      return semver.satisfies(version, range);
    } catch {
      return false;
    }
  });
}

/** The same release line: same major, or same minor below 1.0. */
export function sameLine(a: string, b: string): boolean {
  return (
    semver.major(a) === semver.major(b) &&
    (semver.major(a) > 0 || semver.minor(a) === semver.minor(b))
  );
}

function toFix(
  found: PackageVersion,
  requires: string,
  { now, gateHours }: Clock,
): Fix {
  const ageHours = Math.round((now - found.publishedAt) / HOUR_MS);
  return {
    version: found.version,
    ageHours,
    gated: ageHours < gateHours,
    requires,
  };
}

/** Parents that request the vulnerable package at a version the advisory covers. */
export function findConsumers(
  entries: LockEntry[],
  pkg: string,
  vulnerable: string[],
): Consumer[] {
  const resolution = new Map<string, string>();
  for (const entry of entries) {
    if (entry.name === pkg) {
      for (const descriptor of entry.descriptors) {
        resolution.set(descriptor.slice(pkg.length + 1), entry.version);
      }
    }
  }

  const found = new Map<string, Consumer>();
  for (const entry of entries) {
    const requested = entry.dependencies[pkg];
    if (entry.name === pkg || requested === undefined) {
      continue;
    }
    const range = stripNpm(requested);
    const resolved = resolution.get(`npm:${range}`);
    if (resolved && isVulnerable(resolved, vulnerable)) {
      found.set(`${entry.name}@${entry.version}|${range}`, {
        parent: entry.name,
        parentVersion: entry.version,
        range,
        resolved,
      });
    }
  }
  return [...found.values()].sort((a, b) =>
    `${a.parent}@${a.parentVersion}`.localeCompare(
      `${b.parent}@${b.parentVersion}`,
    ),
  );
}

/** Newest release of `pkg` inside `range` that the advisory does not cover. */
export function newestSafeInRange(
  range: string,
  pkgInfo: PackageInfo,
  vulnerable: string[],
  clock: Clock,
): Fix | undefined {
  const safe = pkgInfo.versions.filter((candidate) => {
    try {
      return (
        semver.satisfies(candidate.version, range) &&
        !isVulnerable(candidate.version, vulnerable)
      );
    } catch {
      return false;
    }
  });
  const newest = safe.at(-1);
  return newest ? toFix(newest, range, clock) : undefined;
}

/**
 * The first newer release of the parent whose range for `pkg` leaves no
 * vulnerable version, on the parent's own line and on any line.
 */
export function parentFixes(
  parentInfo: PackageInfo,
  consumer: Consumer,
  pkg: string,
  pkgInfo: PackageInfo,
  vulnerable: string[],
  clock: Clock,
): { sameLine?: Fix; anyLine?: Fix } {
  const result: { sameLine?: Fix; anyLine?: Fix } = {};
  for (const candidate of parentInfo.versions) {
    if (semver.lte(candidate.version, consumer.parentVersion)) {
      continue;
    }
    const range = candidate.ranges[pkg];
    const safe =
      range === undefined
        ? undefined
        : newestSafeInRange(stripNpm(range), pkgInfo, vulnerable, clock);
    if (range !== undefined && !safe) {
      continue;
    }
    const fix = toFix(candidate, range === undefined ? 'none' : range, clock);
    result.anyLine ??= fix;
    if (sameLine(candidate.version, consumer.parentVersion)) {
      result.sameLine ??= fix;
    }
    if (result.sameLine) {
      break;
    }
  }
  return result;
}

/** Packages that request the parent at a range the fixed release does not satisfy. */
export function findBlockers(
  entries: LockEntry[],
  parent: string,
  fixedVersion: string,
): Blocker[] {
  const blockers = new Map<string, Blocker>();
  for (const entry of entries) {
    const requested = entry.dependencies[parent];
    if (entry.name === parent || requested === undefined) {
      continue;
    }
    const range = stripNpm(requested);
    let satisfied = true;
    try {
      satisfied = semver.satisfies(fixedVersion, range);
    } catch {
      // Not a semver range (a patch: or workspace: protocol); do not guess.
    }
    if (!satisfied) {
      blockers.set(`${entry.name}@${entry.version}`, {
        name: entry.name,
        version: entry.version,
        range,
      });
    }
  }
  return [...blockers.values()];
}

/** Newest release of each release line that the advisory does not cover. */
export function safeLines(
  pkgInfo: PackageInfo,
  vulnerable: string[],
  clock: Clock,
): Fix[] {
  const newestPerLine = new Map<string, PackageVersion>();
  for (const candidate of pkgInfo.versions) {
    const major = semver.major(candidate.version);
    const line =
      major > 0 ? `${major}` : `0.${semver.minor(candidate.version)}`;
    newestPerLine.set(line, candidate);
  }
  return [...newestPerLine.values()]
    .filter((candidate) => !isVulnerable(candidate.version, vulnerable))
    .map((candidate) => toFix(candidate, '', clock));
}

// Packages whose upgrade drags a whole tool stack with it, so a lockfile diff here is wide.
const TOOLCHAIN_FAMILIES: [string, RegExp][] = [
  ['typescript-eslint', /^(@typescript-eslint\/|typescript-eslint$)/u],
  ['eslint', /^(eslint($|-)|@eslint\/)/u],
  ['webpack', /^(webpack($|-)|terser-webpack-plugin$|.+-loader$)/u],
  ['babel', /^(@babel\/|babel-)/u],
  ['jest', /^(jest($|-)|@jest\/|ts-jest$)/u],
  ['storybook', /^(storybook$|@storybook\/)/u],
  ['typescript', /^typescript$/u],
];

export function toolchainFamily(name: string): string | undefined {
  return TOOLCHAIN_FAMILIES.find(([, pattern]) => pattern.test(name))?.[0];
}

/** Flags on a parent upgrade that say how much else it is likely to move. */
export function blastNotes(consumer: Consumer, fix: Fix): string[] {
  const notes: string[] = [];
  const family = toolchainFamily(consumer.parent);
  if (family) {
    notes.push(`moves the ${family} toolchain`);
  }
  if (semver.major(fix.version) !== semver.major(consumer.parentVersion)) {
    notes.push('major jump');
  }
  return notes;
}

const describeFix = (fix: Fix | undefined, consumer?: Consumer): string => {
  if (!fix) {
    return 'none';
  }
  const gate = fix.gated ? `, **inside the age gate: needs --preapprove**` : '';
  const notes = consumer ? blastNotes(consumer, fix) : [];
  const blast = notes.length > 0 ? `, **${notes.join('; ')}**` : '';
  return `${fix.version} (needs \`${fix.requires}\`, ${fix.ageHours} h old${gate}${blast})`;
};

export type ConsumerRow = {
  consumer: Consumer;
  inRange?: Fix;
  fixes: { sameLine?: Fix; anyLine?: Fix };
  blockers: Blocker[];
  unavailable?: boolean;
};

export type ConsumerSection = {
  pkg: string;
  vulnerable: string[];
  safeLines: Fix[];
  /** Unaffected versions of the package that `yarn.lock` already holds. */
  installedSafe: string[];
  rows: ConsumerRow[];
};

const describeBlockers = (blockers: Blocker[]): string =>
  blockers.length === 0
    ? 'none'
    : blockers
        .map((b) =>
          b.version === '0.0.0-use.local'
            ? `this repo's package.json (\`${b.range}\`)`
            : `${b.name}@${b.version} (\`${b.range}\`)`,
        )
        .join(', ');

export function renderConsumerReport(
  sections: ConsumerSection[],
  gateHours: number,
): string {
  const lines = [
    '# Fixes per consumer',
    '',
    `Each row is a parent whose range lets the vulnerable package resolve to an affected version. Age gate: ${gateHours} h. Yarn skips a younger release without printing an error, so a fix marked "inside the age gate" is only reachable with \`--preapprove\`.`,
    '',
    "Work through the rows: a row with a fix on the same line comes first, then a fix on another line, and a resolution only for rows with neither. A fix only removes the parent's own request; a new release can bring a different parent of the vulnerable package, so check `yarn why -R <package>` and the audit after each change.",
    '',
  ];
  for (const section of sections) {
    lines.push(
      `## ${section.pkg}`,
      '',
      `Affected: ${section.vulnerable.join(' | ')}`,
      '',
      `Unaffected versions already in \`yarn.lock\` (prefer one of these for a resolution, so no extra version is added): ${
        section.installedSafe.length === 0
          ? 'none'
          : section.installedSafe.join(', ')
      }`,
      '',
      `Release lines of \`${section.pkg}\` the advisory does not cover (newest each): ${
        section.safeLines.length === 0
          ? 'none'
          : section.safeLines
              .map(
                (fix) =>
                  `${fix.version}${fix.gated ? ` (${fix.ageHours} h old, inside the age gate)` : ''}`,
              )
              .join(', ')
      }`,
      '',
      '| Parent | Requests | Resolves to | Newest unaffected inside that range | Fix on the same line | Fix on another line | Blocked by |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    if (section.rows.length === 0) {
      lines.push(
        '| none: no parent in `yarn.lock` resolves to an affected version | | | | | | |',
      );
    }
    for (const row of section.rows) {
      const { consumer } = row;
      lines.push(
        row.unavailable
          ? `| ${consumer.parent} ${consumer.parentVersion} | \`${consumer.range}\` | ${consumer.resolved} | registry lookup failed | | | |`
          : `| ${consumer.parent} ${consumer.parentVersion} | \`${consumer.range}\` | ${consumer.resolved} | ${describeFix(row.inRange)} | ${describeFix(row.fixes.sameLine, consumer)} | ${describeFix(row.fixes.anyLine, consumer)} | ${describeBlockers(row.blockers)} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

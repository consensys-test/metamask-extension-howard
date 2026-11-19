// Writes `.tmp/audit-autofix/consumers.md`: for every vulnerable package in the audit, each parent
// that lets it resolve to an affected version, with the cheapest fix on that parent's own release
// line, the unaffected release lines of the vulnerable package, and the age-gate state of each fix.
// The agent works from this table instead of querying the registry by hand.
//
// Usage: yarn tsx .github/scripts/audit-consumers.mts [--audit file] [--out file]
import { readFileSync, writeFileSync } from 'node:fs';
import semver from 'semver';
import { argValue } from './shared/cli.mts';
import type { ParsedAdvisory } from './shared/audit-utils.mts';
import {
  findBlockers,
  findConsumers,
  isVulnerable,
  newestSafeInRange,
  parentFixes,
  renderConsumerReport,
  safeLines,
  sameLine,
  type ConsumerRow,
  type ConsumerSection,
  type PackageInfo,
} from './shared/audit-consumers.mts';
import { parseLockfile } from './shared/lockfile-churn.mts';

const WORKSPACE_VERSION = '0.0.0-use.local';
const CONCURRENCY = 4;

const auditFile = argValue('--audit') ?? '.tmp/audit-autofix/audit-before.json';
const outFile = argValue('--out') ?? '.tmp/audit-autofix/consumers.md';

const gateMinutes = Number(
  /^npmMinimalAgeGate:\s*(\d+)/mu.exec(
    readFileSync('.yarnrc.yml', 'utf8'),
  )?.[1] ?? 0,
);
const clock = { now: Date.now(), gateHours: gateMinutes / 60 };

const advisories = JSON.parse(
  readFileSync(auditFile, 'utf8'),
) as ParsedAdvisory[];
const entries = parseLockfile(readFileSync('yarn.lock', 'utf8'));

const vulnerableByPackage = new Map<string, string[]>();
for (const advisory of advisories) {
  const ranges = vulnerableByPackage.get(advisory.moduleName) ?? [];
  ranges.push(advisory.vulnerableVersions);
  vulnerableByPackage.set(advisory.moduleName, ranges);
}
const watched = [...vulnerableByPackage.keys()];

const cache = new Map<string, Promise<PackageInfo | undefined>>();

// Only the ranges for the watched packages are kept, so large packuments stay small in memory.
async function loadPackage(name: string): Promise<PackageInfo | undefined> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${name.replace('/', '%2F')}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok) {
      return undefined;
    }
    const document = (await response.json()) as {
      time?: Record<string, string>;
      versions?: Record<
        string,
        {
          dependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
        }
      >;
    };
    const versions = Object.entries(document.versions ?? {})
      .filter(
        ([version]) =>
          semver.valid(version) && semver.prerelease(version) === null,
      )
      .map(([version, manifest]) => {
        const all = {
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
        };
        return {
          version,
          publishedAt: Date.parse(document.time?.[version] ?? ''),
          ranges: Object.fromEntries(
            watched.filter((n) => n in all).map((n) => [n, all[n]]),
          ),
        };
      })
      .filter(({ publishedAt }) => !Number.isNaN(publishedAt))
      .sort((a, b) => semver.compare(a.version, b.version));
    return { versions };
  } catch {
    return undefined;
  }
}

function packageInfo(name: string): Promise<PackageInfo | undefined> {
  if (!cache.has(name)) {
    cache.set(name, loadPackage(name));
  }
  return cache.get(name) as Promise<PackageInfo | undefined>;
}

async function mapLimited<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

const sections: ConsumerSection[] = [];
for (const pkg of watched) {
  const vulnerable = vulnerableByPackage.get(pkg) as string[];
  const pkgInfo = await packageInfo(pkg);
  const consumers = findConsumers(entries, pkg, vulnerable);

  const rows = await mapLimited(consumers, async (consumer) => {
    const row: ConsumerRow = { consumer, fixes: {}, blockers: [] };
    if (!pkgInfo || consumer.parentVersion === WORKSPACE_VERSION) {
      // A workspace parent is this repo's own package.json: bump or pin it there.
      row.unavailable = !pkgInfo;
      return row;
    }
    const parentInfo = await packageInfo(consumer.parent);
    if (!parentInfo) {
      row.unavailable = true;
      return row;
    }
    row.inRange = newestSafeInRange(consumer.range, pkgInfo, vulnerable, clock);
    row.fixes = parentFixes(
      parentInfo,
      consumer,
      pkg,
      pkgInfo,
      vulnerable,
      clock,
    );
    const target = row.fixes.sameLine ?? row.fixes.anyLine;
    if (target) {
      row.blockers = findBlockers(entries, consumer.parent, target.version);
    }
    return row;
  });

  // The lines installed today plus the three newest: the others only add noise.
  const installed = entries
    .filter((entry) => entry.name === pkg)
    .map((entry) => entry.version)
    .filter((version) => semver.valid(version));
  const lines = pkgInfo ? safeLines(pkgInfo, vulnerable, clock) : [];
  const installedSafe = [...new Set(installed)]
    .filter((version) => !isVulnerable(version, vulnerable))
    .sort(semver.compare);
  sections.push({
    pkg,
    vulnerable,
    installedSafe,
    safeLines: lines.filter(
      (fix, index) =>
        index >= lines.length - 3 ||
        installed.some((version) => sameLine(version, fix.version)),
    ),
    rows,
  });
}

writeFileSync(outFile, renderConsumerReport(sections, clock.gateHours));
console.log(
  `Wrote ${outFile}: ${sections.length} packages, ${sections.reduce((n, s) => n + s.rows.length, 0)} consumers.`,
);

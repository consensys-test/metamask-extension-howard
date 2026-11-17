import semver from 'semver';
import { parseResolutionKey } from './resolutions-lint.mts';
import type { LockEntry } from './lockfile-churn.mts';

export type AddedResolution = {
  key: string;
  value: string;
  packageName: string;
};

export type Trial = {
  /** Advisories for the package that came back when the resolution was removed. */
  advisories: string[];
  /** Versions of the package in the lockfile after re-resolving without it. */
  resolvedVersions: string[];
};

export type ParentVersion = {
  version: string;
  /** Range this parent version declares for the package. */
  range: string | undefined;
};

/**
 * Resolutions the branch added or repointed. Patch entries are not
 * pins, so they are left out.
 */
export function addedResolutions(
  base: Record<string, string>,
  head: Record<string, string>,
): AddedResolution[] {
  return Object.entries(head)
    .filter(
      ([key, value]) => base[key] !== value && !value.startsWith('patch:'),
    )
    .map(([key, value]) => ({
      key,
      value,
      packageName: parseResolutionKey(key).packageName,
    }));
}

export function withoutResolution(
  resolutions: Record<string, string>,
  key: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(resolutions).filter(([name]) => name !== key),
  );
}

/** `package GHSA-id` for every advisory in `yarn npm audit --json` output (one object per line). */
function advisoryLabels(ndjson: string): string[] {
  const labels: string[] = [];
  for (const line of ndjson.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    const { value, children } = JSON.parse(line) as {
      value: string;
      children?: Record<string, string>;
    };
    const { URL: url, Issue: issue } = children ?? {};
    labels.push(`${value} ${url?.split('/').at(-1) ?? issue ?? 'unknown'}`);
  }
  return labels;
}

/**
 * Advisories in `trial` that `baseline` does not have. A resolution can fix an
 * advisory in a different package than the one it pins, so every package counts.
 */
export function returnedAdvisories(trial: string, baseline: string): string[] {
  const known = new Set(advisoryLabels(baseline));
  return advisoryLabels(trial).filter((label) => !known.has(label));
}

/** Packages in the lockfile that depend on `packageName`, with the range they ask for. */
export function parentsOf(
  entries: LockEntry[],
  packageName: string,
): { name: string; version: string; range: string }[] {
  const parents: { name: string; version: string; range: string }[] = [];
  for (const { descriptors, version, dependencies } of entries) {
    const range = dependencies[packageName];
    if (range !== undefined) {
      const name = /^(@?[^@]+)@/u.exec(descriptors[0])?.[1] ?? descriptors[0];
      parents.push({ name, version, range });
    }
  }
  return parents;
}

/**
 * Lowest parent version above `current` whose declared range accepts
 * `fixedVersion`, so a plain upgrade of the parent would make the resolution
 * unnecessary.
 */
export function findParentUpgrade({
  versions,
  current,
  fixedVersion,
}: {
  versions: ParentVersion[];
  current: string;
  fixedVersion: string;
}): string | undefined {
  return versions
    .filter(
      ({ version, range }) =>
        semver.valid(version) !== null &&
        semver.prerelease(version) === null &&
        semver.gt(version, current) &&
        range !== undefined &&
        (semver.satisfies(fixedVersion, range) ||
          // A range that starts at or above the pinned version also avoids the vulnerable one.
          semver.gte(semver.minVersion(range) ?? '0.0.0', fixedVersion)),
    )
    .map(({ version }) => version)
    .sort(semver.compare)[0];
}

/** One line of evidence for the PR body. */
export function formatEvidence({
  resolution,
  trial,
  parentUpgrades,
}: {
  resolution: AddedResolution;
  trial: Trial;
  parentUpgrades: string[];
}): string {
  const head = `- \`${resolution.key}\` -> \`${resolution.value}\`:`;
  if (trial.advisories.length === 0) {
    return `${head} not needed, without it ${resolution.packageName} resolves to ${trial.resolvedVersions.join(', ') || 'nothing'} and no advisory returns.`;
  }
  const returned = `needed, without it ${trial.advisories.length} advisory(ies) return (${trial.advisories.join(', ')})`;
  return parentUpgrades.length === 0
    ? `${head} ${returned}; no parent upgrade found that avoids it.`
    : `${head} ${returned}; avoidable by upgrading ${parentUpgrades.join(', ')}.`;
}

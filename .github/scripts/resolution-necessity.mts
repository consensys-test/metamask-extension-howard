// For every resolution the branch added: removes it, re-resolves, re-audits, and when the
// advisory returns looks for a parent upgrade that would make the resolution unnecessary.
// Prints one line of evidence per resolution (for the PR body). Package.json and yarn.lock
// are restored after every trial. Each trial costs one lockfile update plus one audit.
//
// Usage: yarn tsx .github/scripts/resolution-necessity.mts --base <package.json> [--head package.json] [--out <file>]
// Set NECESSITY_YARN_COMMAND="corepack yarn" where plain `yarn` is not on PATH.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import semver from 'semver';
import { parseLockfile } from './shared/lockfile-churn.mts';
import { parseResolutionKey } from './shared/resolutions-lint.mts';
import {
  addedResolutions,
  returnedAdvisories,
  findParentUpgrade,
  formatEvidence,
  parentsOf,
  withoutResolution,
  type AddedResolution,
  type ParentVersion,
  type Trial,
} from './shared/resolution-necessity.mts';

const NEWEST_PARENT_VERSIONS = 10;
const [YARN, ...YARN_ARGS] = (
  process.env.NECESSITY_YARN_COMMAND ?? 'yarn'
).split(' ');

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function yarn(args: string[], tolerateFailure = false): string {
  try {
    return execFileSync(YARN, [...YARN_ARGS, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // `yarn npm audit` exits non-zero whenever it finds advisories.
    if (!tolerateFailure) {
      throw error;
    }
    return (error as { stdout?: string }).stdout ?? '';
  }
}

function updateLockfile(): void {
  const output = yarn(['install', '--mode=update-lockfile'], true);
  // Without node_modules the install still exits 1 after the lockfile update (postinstall).
  if (/YN0(001|016|027|035)/u.test(output) || !output.includes('Link step')) {
    throw new Error(`Lockfile update failed:\n${output}`);
  }
}

function npmInfo<Value>(spec: string, field: string): Value | undefined {
  const output = yarn(['npm', 'info', spec, '--json', '--fields', field], true);
  try {
    return (JSON.parse(output) as Record<string, Value>)[field];
  } catch {
    return undefined;
  }
}

function runTrial(
  resolution: AddedResolution,
  headPackage: Record<string, unknown> & {
    resolutions: Record<string, string>;
  },
  baselineAudit: string,
): { trial: Trial; lockText: string } {
  const trialPackage = {
    ...headPackage,
    resolutions: withoutResolution(headPackage.resolutions, resolution.key),
  };
  writeFileSync('package.json', `${JSON.stringify(trialPackage, null, 2)}\n`);
  updateLockfile();
  const audit = yarn(['npm', 'audit', '--recursive', '--json'], true);
  const lockText = readFileSync('yarn.lock', 'utf8');

  return {
    trial: {
      advisories: returnedAdvisories(audit, baselineAudit),
      resolvedVersions: parseLockfile(lockText)
        .filter(({ name }) => name === resolution.packageName)
        .map(({ version }) => version),
    },
    lockText,
  };
}

function parentUpgrades(
  resolution: AddedResolution,
  trialLock: string,
  fixedVersion: string | undefined,
): string[] {
  if (!fixedVersion) {
    return [];
  }
  const { scoped, key } = parseResolutionKey(resolution.key);
  const wantedRange = /^.*?[^/]@(?:npm:)?(.+)$/u.exec(key)?.[1];
  const owner = scoped ? key.slice(0, key.lastIndexOf('/')) : undefined;

  const upgrades: string[] = [];
  for (const parent of parentsOf(
    parseLockfile(trialLock),
    resolution.packageName,
  )) {
    if (
      (owner && parent.name !== owner) ||
      (wantedRange && parent.range.replace(/^npm:/u, '') !== wantedRange)
    ) {
      continue;
    }
    const all = npmInfo<string[]>(parent.name, 'versions') ?? [];
    const candidates = all
      .filter(
        (version) =>
          semver.valid(version) && semver.gt(version, parent.version),
      )
      .slice(-NEWEST_PARENT_VERSIONS);
    const versions: ParentVersion[] = candidates.map((version) => ({
      version,
      range: npmInfo<Record<string, string>>(
        `${parent.name}@${version}`,
        'dependencies',
      )?.[resolution.packageName],
    }));
    const target = findParentUpgrade({
      versions,
      current: parent.version,
      fixedVersion,
    });
    if (target) {
      upgrades.push(`${parent.name} ${parent.version} -> ${target}`);
    }
  }
  return upgrades;
}

function main(): void {
  const readPackage = (file: string) =>
    JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & {
      resolutions: Record<string, string>;
    };
  const base = readPackage(argValue('--base') ?? '');
  const headFile = argValue('--head') ?? 'package.json';
  const head = readPackage(headFile);

  const originalPackage = readFileSync('package.json', 'utf8');
  const originalLock = readFileSync('yarn.lock', 'utf8');
  const headVersions = parseLockfile(originalLock);

  const baselineAudit = yarn(['npm', 'audit', '--recursive', '--json'], true);
  const lines: string[] = [];
  try {
    for (const resolution of addedResolutions(
      base.resolutions,
      head.resolutions,
    )) {
      const { trial, lockText } = runTrial(resolution, head, baselineAudit);
      const fixedVersion = semver.maxSatisfying(
        headVersions
          .filter(({ name }) => name === resolution.packageName)
          .map(({ version }) => version),
        resolution.value,
      );
      const upgrades =
        trial.advisories.length > 0
          ? parentUpgrades(resolution, lockText, fixedVersion ?? undefined)
          : [];
      const line = formatEvidence({
        resolution,
        trial,
        parentUpgrades: upgrades,
      });
      console.log(line);
      lines.push(line);

      writeFileSync('package.json', originalPackage);
      writeFileSync('yarn.lock', originalLock);
    }
  } finally {
    writeFileSync('package.json', originalPackage);
    writeFileSync('yarn.lock', originalLock);
  }

  const out = argValue('--out');
  if (out) {
    writeFileSync(out, `${lines.join('\n')}\n`);
  }
}

main();

import type { LockEntry } from './lockfile-churn.mts';

type Dependent = {
  /** Package that declares the dependency; the workspace name for root dependencies. */
  parent: string;
  /** Range as declared, without the `npm:` protocol. */
  range: string;
};

const KEY_PATTERN =
  /^(?:(?<parent>\*\*|(?:@[^/]+\/)?[^/@]+(?:@[^/]+)?)\/)?(?<name>(?:@[^/]+\/)?[^/@]+)(?:@(?<range>.+))?$/u;

const withoutNpmProtocol = (range: string): string =>
  range.replace(/^npm:/u, '');

/**
 * Splits a `resolutions` key (`name`, `name@range`, `parent/name`, `parent@range/name@range`)
 * into its parts. Returns undefined for a shape this module does not understand.
 */
export function splitResolutionKey(
  key: string,
): { parent?: string; name: string; range?: string } | undefined {
  const groups = KEY_PATTERN.exec(key)?.groups;
  if (!groups?.name) {
    return undefined;
  }
  return {
    parent: groups.parent,
    name: groups.name,
    range: groups.range ? withoutNpmProtocol(groups.range) : undefined,
  };
}

function collectDependents({
  entries,
  rootName,
  rootDependencies,
}: {
  entries: LockEntry[];
  rootName: string;
  rootDependencies: Record<string, string>;
}): Map<string, Dependent[]> {
  const dependents = new Map<string, Dependent[]>();
  const add = (name: string, parent: string, range: string): void => {
    dependents.set(name, [
      ...(dependents.get(name) ?? []),
      { parent, range: withoutNpmProtocol(range) },
    ]);
  };
  for (const [name, range] of Object.entries(rootDependencies)) {
    add(name, rootName, range);
  }
  for (const entry of entries) {
    for (const [name, range] of Object.entries(entry.dependencies)) {
      add(name, entry.name, range);
    }
  }
  return dependents;
}

/**
 * Resolutions that no dependency in the project can match any more. The lockfile keeps the
 * ranges as declared by each package, so a key is live while some package still asks for
 * that package (and that range, when the key names one). A key this module cannot parse,
 * or one with a parent range, counts as live: pruning must only remove what is surely dead.
 */
export function deadPins({
  resolutions,
  entries,
  rootName,
  rootDependencies,
}: {
  resolutions: Record<string, string>;
  entries: LockEntry[];
  rootName: string;
  rootDependencies: Record<string, string>;
}): string[] {
  const dependents = collectDependents({ entries, rootName, rootDependencies });

  return Object.keys(resolutions).filter((key) => {
    const parts = splitResolutionKey(key);
    if (!parts) {
      return false;
    }
    const { parent, name, range } = parts;
    if (parent?.includes('@')) {
      return false;
    }
    return !(dependents.get(name) ?? []).some(
      (dependent) =>
        (parent === undefined ||
          parent === '**' ||
          dependent.parent === parent) &&
        (range === undefined || dependent.range === range),
    );
  });
}

/** Patch files whose basename appears in none of the given texts (`package.json`, `yarn.lock`). */
export function unreferencedPatches(
  patchFiles: string[],
  texts: string[],
): string[] {
  return patchFiles.filter(
    (file) => !texts.some((text) => text.includes(file)),
  );
}

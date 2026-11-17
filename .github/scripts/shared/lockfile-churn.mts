export type LockEntry = {
  name: string;
  version: string;
  descriptors: string[];
  dependencies: Record<string, string>;
};

export type PackageChange = {
  name: string;
  before: string[];
  after: string[];
  targeted: boolean;
  /** True when the package is reachable from the root `dependencies` (it ships in the extension). */
  production: boolean;
  /** True when a targeted package depends on it, directly or transitively, in the new lockfile. */
  reachable: boolean;
  /** True when a major version appeared that the package did not have before. */
  majorJump: boolean;
  /** True when the package already existed and now resolves to more versions. */
  extraVersion: boolean;
};

const unquote = (text: string): string => text.replace(/^"(.*)"$/u, '$1');

/** Package name of a descriptor such as `@scope/pkg@npm:^1.0.0`. */
export function descriptorName(descriptor: string): string {
  return /^(@?[^@]+)@/u.exec(descriptor)?.[1] ?? descriptor;
}

/** Reads the resolution blocks of a Yarn berry `yarn.lock`. */
export function parseLockfile(text: string): LockEntry[] {
  const entries: LockEntry[] = [];

  for (const block of text.split(/\r?\n\r?\n/u)) {
    const lines = block
      .split(/\r?\n/u)
      .filter((line) => line !== '' && !line.startsWith('#'));
    const [header] = lines;
    if (
      !header ||
      header.startsWith(' ') ||
      !header.endsWith(':') ||
      header.startsWith('__metadata')
    ) {
      continue;
    }

    // The whole header is one quoted string, even when it lists several descriptors.
    const descriptors = unquote(header.slice(0, -1)).split(', ');
    const versionLine = lines.find((line) => line.startsWith('  version: '));
    if (!versionLine) {
      continue;
    }

    const dependencies: Record<string, string> = {};
    const start = lines.indexOf('  dependencies:');
    if (start !== -1) {
      for (const line of lines.slice(start + 1)) {
        if (!line.startsWith('    ')) {
          break;
        }
        const match = /^ {4}(".+?"|[^:]+): (.*)$/u.exec(line);
        if (match) {
          dependencies[unquote(match[1])] = unquote(match[2]);
        }
      }
    }

    entries.push({
      name: descriptorName(descriptors[0]),
      version: unquote(versionLine.slice('  version: '.length)),
      descriptors,
      dependencies,
    });
  }

  return entries;
}

/**
 * Names of every package reachable from the root `dependencies` (not
 * `devDependencies`). A descriptor that no lockfile entry lists, which happens
 * when a resolution rewrote it, falls back to every entry with that name, so
 * the set errs towards "ships in production".
 */
export function productionPackages(
  entries: LockEntry[],
  rootDependencies: Record<string, string>,
): Set<string> {
  const byDescriptor = new Map<string, LockEntry[]>();
  const byName = new Map<string, LockEntry[]>();
  for (const entry of entries) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
    for (const descriptor of entry.descriptors) {
      byDescriptor.set(descriptor, [
        ...(byDescriptor.get(descriptor) ?? []),
        entry,
      ]);
    }
  }

  const seen = new Set<LockEntry>();
  const queue = Object.entries(rootDependencies).map(
    ([name, range]) =>
      [name, range.includes(':') ? range : `npm:${range}`] as const,
  );

  while (queue.length > 0) {
    const [name, range] = queue.pop() as readonly [string, string];
    const found =
      byDescriptor.get(`${name}@${range}`) ?? byName.get(name) ?? [];
    for (const entry of found) {
      if (!seen.has(entry)) {
        seen.add(entry);
        queue.push(...Object.entries(entry.dependencies));
      }
    }
  }

  return new Set([...seen].map((entry) => entry.name));
}

/**
 * Names of every package a target depends on, directly or transitively, in
 * the given lockfile. Descriptors that no entry lists fall back to the name.
 */
export function reachableFromTargets(
  entries: LockEntry[],
  targets: ReadonlySet<string>,
): Set<string> {
  const byDescriptor = new Map<string, LockEntry[]>();
  const byName = new Map<string, LockEntry[]>();
  for (const entry of entries) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
    for (const descriptor of entry.descriptors) {
      byDescriptor.set(descriptor, [
        ...(byDescriptor.get(descriptor) ?? []),
        entry,
      ]);
    }
  }

  const seen = new Set<LockEntry>();
  const queue = entries.filter((entry) => targets.has(entry.name));
  while (queue.length > 0) {
    const entry = queue.pop() as LockEntry;
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    for (const [name, range] of Object.entries(entry.dependencies)) {
      queue.push(
        ...(byDescriptor.get(`${name}@${range}`) ?? byName.get(name) ?? []),
      );
    }
  }

  return new Set([...seen].map((entry) => entry.name));
}

const majorOf = (version: string): string => version.split('.')[0];

function versionsByName(entries: LockEntry[]): Map<string, string[]> {
  const versions = new Map<string, Set<string>>();
  for (const { name, version } of entries) {
    versions.set(name, (versions.get(name) ?? new Set()).add(version));
  }
  return new Map(
    [...versions].map(([name, set]) => [name, [...set].sort()] as const),
  );
}

/** Lists every package whose set of resolved versions differs between two lockfiles. */
export function computeChurn({
  before,
  after,
  targets,
  rootDependencies,
}: {
  before: LockEntry[];
  after: LockEntry[];
  targets: ReadonlySet<string>;
  rootDependencies: Record<string, string>;
}): PackageChange[] {
  const beforeVersions = versionsByName(before);
  const afterVersions = versionsByName(after);
  const production = productionPackages(after, rootDependencies);
  const reachable = reachableFromTargets(after, targets);
  const changes: PackageChange[] = [];

  for (const name of new Set([
    ...beforeVersions.keys(),
    ...afterVersions.keys(),
  ])) {
    const previous = beforeVersions.get(name) ?? [];
    const next = afterVersions.get(name) ?? [];
    if (previous.join() !== next.join()) {
      changes.push({
        name,
        before: previous,
        after: next,
        targeted: targets.has(name),
        production: production.has(name),
        reachable: reachable.has(name),
        majorJump:
          previous.length > 0 &&
          next.some(
            (version) =>
              !previous.some((old) => majorOf(old) === majorOf(version)),
          ),
        extraVersion: previous.length > 0 && next.length > previous.length,
      });
    }
  }

  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

/** Changes that ship in the extension and that no targeted package explains. */
export function riskyChanges(changes: PackageChange[]): PackageChange[] {
  return changes.filter(
    (change) => !change.targeted && !change.reachable && change.production,
  );
}

/** Production packages that moved only because a targeted package depends on them. */
export function movedWithTargets(changes: PackageChange[]): PackageChange[] {
  return changes.filter(
    (change) => !change.targeted && change.reachable && change.production,
  );
}

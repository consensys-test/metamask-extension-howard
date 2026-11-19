export type ResolutionViolation = {
  packageName: string;
  kind: 'split' | 'unsorted';
  detail: string;
};

type ParsedKey = {
  key: string;
  packageName: string;
  /** True for `parent/child` keys, which authors place next to the parent, so blocks ignore them. */
  scoped: boolean;
  version: number[] | null;
};

/**
 * Splits a `resolutions` key such as `parent/child@npm:^1.2.3` into the package it
 * resolves (the last ident, `child`) and the version in its range, if any.
 */
export function parseResolutionKey(key: string): ParsedKey {
  // The range starts at the first `@` that does not begin a scope (`@scope/` at the start or after `/`).
  const match = /^(.*?[^/])@(.*)$/u.exec(key);
  const ident = match ? match[1] : key;
  const range = match ? match[2] : '';

  const segments = ident.split('/');
  const last = segments[segments.length - 1];
  const scopedName =
    segments.length > 1 && segments[segments.length - 2].startsWith('@');
  const packageName = scopedName
    ? `${segments[segments.length - 2]}/${last}`
    : last;
  const scoped = segments.length > (scopedName ? 2 : 1);

  const numbers = /\d+(?:\.\d+)*/u.exec(range.replace(/^npm:/u, ''))?.[0];
  return {
    key,
    packageName,
    scoped,
    version: numbers ? numbers.split('.').map(Number) : null,
  };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

const parseNonScoped = (resolutions: Record<string, unknown>) =>
  Object.keys(resolutions)
    .map(parseResolutionKey)
    .filter((entry) => !entry.scoped);

/** Packages whose keys or values differ from `base` (every package without a base). */
function touchedPackages({
  base,
  head,
}: {
  base?: Record<string, unknown>;
  head: Record<string, unknown>;
}): Set<string> {
  const touched = new Set<string>();
  for (const { key, packageName } of parseNonScoped(head)) {
    if (
      !base ||
      !(key in base) ||
      JSON.stringify(base[key]) !== JSON.stringify(head[key])
    ) {
      touched.add(packageName);
    }
  }
  for (const { key, packageName } of base ? parseNonScoped(base) : []) {
    if (!(key in head)) {
      touched.add(packageName);
    }
  }
  return touched;
}

/**
 * Puts each touched package's keys into one block sorted by ascending version, at the
 * position of the package's first key. Keys without a version come first, and
 * parent/child keys stay where they are.
 */
export function sortResolutions<Value>({
  base,
  head,
}: {
  base?: Record<string, unknown>;
  head: Record<string, Value>;
}): Record<string, Value> {
  const touched = touchedPackages({ base, head });
  const blocks = new Map<string, ParsedKey[]>();
  for (const entry of parseNonScoped(head)) {
    if (touched.has(entry.packageName)) {
      blocks.set(entry.packageName, [
        ...(blocks.get(entry.packageName) ?? []),
        entry,
      ]);
    }
  }

  const sorted: [string, Value][] = [];
  const emitted = new Set<string>();
  for (const key of Object.keys(head)) {
    const { packageName, scoped } = parseResolutionKey(key);
    if (scoped || !touched.has(packageName)) {
      sorted.push([key, head[key]]);
    } else if (!emitted.has(packageName)) {
      emitted.add(packageName);
      const block = [...(blocks.get(packageName) ?? [])].sort((a, b) =>
        a.version && b.version
          ? compareVersions(a.version, b.version)
          : Number(Boolean(a.version)) - Number(Boolean(b.version)),
      );
      sorted.push(
        ...block.map(({ key: blockKey }): [string, Value] => [
          blockKey,
          head[blockKey],
        ]),
      );
    }
  }
  return Object.fromEntries(sorted);
}

/**
 * Every package's keys must form one contiguous block, sorted by ascending
 * version. Only packages whose keys or values differ from `base` are checked, since
 * older blocks were not kept sorted.
 */
export function lintResolutions({
  base,
  head,
}: {
  base?: Record<string, unknown>;
  head: Record<string, unknown>;
}): ResolutionViolation[] {
  const keys = parseNonScoped(head);
  const touched = touchedPackages({ base, head });

  const violations: ResolutionViolation[] = [];
  for (const packageName of touched) {
    const indexes = keys.flatMap((entry, index) =>
      entry.packageName === packageName ? [index] : [],
    );
    if (indexes.length === 0) {
      continue;
    }

    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    if (last - first + 1 !== indexes.length) {
      const between = keys
        .slice(first, last + 1)
        .filter((entry) => entry.packageName !== packageName)
        .map((entry) => entry.key);
      violations.push({
        packageName,
        kind: 'split',
        detail: `keys are interleaved with ${between.slice(0, 3).join(', ')}`,
      });
      continue;
    }

    const versioned = keys
      .slice(first, last + 1)
      .filter(
        (entry): entry is ParsedKey & { version: number[] } =>
          entry.version !== null,
      );
    for (let i = 1; i < versioned.length; i++) {
      if (compareVersions(versioned[i - 1].version, versioned[i].version) > 0) {
        violations.push({
          packageName,
          kind: 'unsorted',
          detail: `${versioned[i].key} should come before ${versioned[i - 1].key}`,
        });
        break;
      }
    }
  }

  return violations.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

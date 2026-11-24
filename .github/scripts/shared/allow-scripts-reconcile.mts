export type AllowScripts = Record<string, boolean>;

export type AllowScriptsChange = {
  key: string;
  before: boolean | undefined;
  after: boolean | undefined;
};

export type ReconcileResult = {
  /** `base` plus only the changes that belong to packages the fix changed. */
  reconciled: AllowScripts;
  related: AllowScriptsChange[];
  unrelated: AllowScriptsChange[];
};

/**
 * Package names on the dependency path of an allow-scripts key, for example
 * `gulp>undertaker>es6-weak-map>es5-ext#0.10.64` gives gulp, undertaker,
 * es6-weak-map and es5-ext. `$root$` is not a package.
 */
export function keyPackageNames(key: string): string[] {
  return key
    .split('>')
    .map((segment) => segment.replace(/#.*$/u, ''))
    .filter((name) => name !== '' && name !== '$root$');
}

export function diffAllowScripts(
  base: AllowScripts,
  head: AllowScripts,
): AllowScriptsChange[] {
  return [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .filter((key) => base[key] !== head[key])
    .sort()
    .map((key) => ({ key, before: base[key], after: head[key] }));
}

/**
 * `yarn allow-scripts auto` rewrites the block from whatever is installed, so
 * a stale `node_modules` can add or drop unrelated entries. Only changes whose
 * dependency path contains a package the fix changed in `yarn.lock` are kept.
 */
export function reconcileAllowScripts({
  base,
  auto,
  changedPackages,
}: {
  base: AllowScripts;
  auto: AllowScripts;
  changedPackages: ReadonlySet<string>;
}): ReconcileResult {
  const leaf = (key: string): string | undefined => keyPackageNames(key).at(-1);
  const changes = diffAllowScripts(base, auto);
  const isRelated = (change: AllowScriptsChange): boolean =>
    keyPackageNames(change.key).some((name) => changedPackages.has(name));

  // An entry whose path changed shows up as a removal plus an addition with
  // the same leaf package, and only one of the two paths may touch a package
  // the fix changed, so the partner of a related change is related too.
  const relatedLeaves = new Set(
    changes.filter(isRelated).map(({ key }) => leaf(key)),
  );
  const related: AllowScriptsChange[] = [];
  const unrelated: AllowScriptsChange[] = [];
  for (const change of changes) {
    const partnered =
      (change.before === undefined) !== (change.after === undefined) &&
      relatedLeaves.has(leaf(change.key));
    (isRelated(change) || partnered ? related : unrelated).push(change);
  }

  const reconciled: AllowScripts = { ...base };
  for (const { key, after } of related) {
    if (after === undefined) {
      delete reconciled[key];
    } else {
      reconciled[key] = after;
    }
  }

  return { reconciled, related, unrelated };
}

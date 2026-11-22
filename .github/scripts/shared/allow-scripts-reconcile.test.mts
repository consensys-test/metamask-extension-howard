import {
  diffAllowScripts,
  keyPackageNames,
  reconcileAllowScripts,
} from './allow-scripts-reconcile.mts';

describe('keyPackageNames', () => {
  it('splits the path and drops versions and the root marker', () => {
    expect(
      keyPackageNames('gulp>undertaker>es6-weak-map>es5-ext#0.10.64'),
    ).toStrictEqual(['gulp', 'undertaker', 'es6-weak-map', 'es5-ext']);
    expect(keyPackageNames('$root$')).toStrictEqual([]);
    expect(keyPackageNames('@google/genai>protobufjs')).toStrictEqual([
      '@google/genai',
      'protobufjs',
    ]);
  });
});

describe('diffAllowScripts', () => {
  it('reports added, removed and flipped keys, sorted', () => {
    expect(
      diffAllowScripts(
        { a: false, b: true, c: true },
        { a: false, b: false, d: true },
      ),
    ).toStrictEqual([
      { key: 'b', before: true, after: false },
      { key: 'c', before: true, after: undefined },
      { key: 'd', before: undefined, after: true },
    ]);
  });
});

describe('reconcileAllowScripts', () => {
  const base = {
    'resolve-url-loader>es6-iterator>es5-ext': false,
    '@swc/core': false,
    ws: true,
  };

  it('keeps the entry move caused by the fix', () => {
    const auto = {
      'gulp>undertaker>es6-weak-map>es5-ext#0.10.64': false,
      '@swc/core': false,
      ws: true,
    };

    const result = reconcileAllowScripts({
      base,
      auto,
      changedPackages: new Set(['es5-ext']),
    });

    expect(result.unrelated).toStrictEqual([]);
    expect(result.reconciled).toStrictEqual(auto);
  });

  it('keeps the new path of an entry whose old path the fix removed', () => {
    const result = reconcileAllowScripts({
      base,
      auto: {
        'gulp>undertaker>es6-weak-map>es5-ext#0.10.64': false,
        '@swc/core': false,
        ws: true,
      },
      changedPackages: new Set(['resolve-url-loader']),
    });

    expect(result.unrelated).toStrictEqual([]);
    expect(result.related).toHaveLength(2);
  });

  it('does not pair an addition with an unrelated flip of the same leaf', () => {
    const result = reconcileAllowScripts({
      base: { 'a>x': false },
      auto: { 'a>x': true },
      changedPackages: new Set(['x-other']),
    });

    expect(result.unrelated).toHaveLength(1);
  });

  it('restores unrelated entries that auto rewrote', () => {
    const result = reconcileAllowScripts({
      base,
      auto: { ...base, '@swc/core': true, 'new>thing': false },
      changedPackages: new Set(['ws']),
    });

    expect(result.related).toStrictEqual([]);
    expect(result.unrelated.map(({ key }) => key)).toStrictEqual([
      '@swc/core',
      'new>thing',
    ]);
    expect(result.reconciled).toStrictEqual(base);
  });

  it('applies a related removal', () => {
    const result = reconcileAllowScripts({
      base,
      auto: { '@swc/core': false, ws: true },
      changedPackages: new Set(['es6-iterator']),
    });

    expect(result.reconciled).toStrictEqual({ '@swc/core': false, ws: true });
  });
});

import {
  lintResolutions,
  parseResolutionKey,
  sortResolutions,
} from './resolutions-lint.mts';

describe('parseResolutionKey', () => {
  const cases: [string, string, number[] | null][] = [
    ['ws', 'ws', null],
    ['ws@~8.17.1', 'ws', [8, 17, 1]],
    ['minimatch@npm:^10.2.2', 'minimatch', [10, 2, 2]],
    ['@scope/pkg@npm:1', '@scope/pkg', [1]],
    ['redux-devtools-core/nanoid', 'nanoid', null],
    [
      '@storybook/builder-webpack5/webpack-dev-middleware',
      'webpack-dev-middleware',
      null,
    ],
    ['@scope/parent/@other/child@^2.0.0', '@other/child', [2, 0, 0]],
  ];
  for (const [key, packageName, version] of cases) {
    it(`reads ${key}`, () => {
      expect(parseResolutionKey(key)).toMatchObject({
        packageName,
        version,
        scoped: key.includes('/') && !/^@[^/]+\/[^/]+(@.*)?$/u.test(key),
      });
    });
  }
});

describe('lintResolutions', () => {
  it('accepts a contiguous block sorted by version, comparing numbers not text', () => {
    expect(
      lintResolutions({
        head: {
          'minimatch@3.1.2': 'a',
          'minimatch@^9.0.4': 'b',
          'minimatch@^10.0.1': 'c',
        },
      }),
    ).toStrictEqual([]);
  });

  it('reports a package whose keys are split by another package', () => {
    const violations = lintResolutions({
      head: { 'minimatch@3.1.2': 'a', ws: 'b', 'minimatch@^9.0.4': 'c' },
    });

    expect(violations).toStrictEqual([
      {
        packageName: 'minimatch',
        kind: 'split',
        detail: 'keys are interleaved with ws',
      },
    ]);
  });

  it('reports an unsorted block', () => {
    const violations = lintResolutions({
      head: { 'minimatch@^10.0.1': 'a', 'minimatch@3.1.2': 'b' },
    });

    expect(violations).toMatchObject([
      { packageName: 'minimatch', kind: 'unsorted' },
    ]);
  });

  it('groups patch entries with the package but ignores parent/child keys', () => {
    expect(
      lintResolutions({
        head: {
          'nanoid@^3.0.0': 'a',
          'redux-devtools-core/nanoid': 'b',
          'nanoid@^3.1.0': 'patch:nanoid@npm%3A3.1.0#x.patch',
        },
      }),
    ).toStrictEqual([]);
    expect(
      lintResolutions({
        head: { 'nanoid@^3.0.0': 'a', ws: 'b', 'nanoid@^3.1.0': 'c' },
      }),
    ).toMatchObject([{ packageName: 'nanoid', kind: 'split' }]);
  });

  it('only checks packages the branch touched', () => {
    const base = { 'a@2.0.0': 'x', 'a@1.0.0': 'x', ws: 'y' };

    expect(lintResolutions({ base, head: { ...base, ws: 'z' } })).toStrictEqual(
      [],
    );
    expect(
      lintResolutions({
        base,
        head: { 'a@2.0.0': 'x', 'a@1.0.0': 'x', 'a@0.5.0': 'new', ws: 'y' },
      }),
    ).toMatchObject([{ packageName: 'a', kind: 'unsorted' }]);
  });
});

describe('sortResolutions', () => {
  it('gathers a touched package into one sorted block at its first key', () => {
    const head = {
      'minimatch@npm:^9.0.4': '^11.0.8',
      'ws@npm:^8.0.0': '^8.21.0',
      'minimatch@npm:3.1.2': '^3.1.5',
      'parent/minimatch': '^11.0.8',
      'minimatch@npm:^7.4.6': '^11.0.8',
    };
    expect(Object.keys(sortResolutions({ head }))).toStrictEqual([
      'minimatch@npm:3.1.2',
      'minimatch@npm:^7.4.6',
      'minimatch@npm:^9.0.4',
      'ws@npm:^8.0.0',
      'parent/minimatch',
    ]);
  });

  it('compares numbers, not text, and puts keys without a version first', () => {
    const head = { 'a@^10.0.0': '1', a: '2', 'a@^9.0.0': '3' };
    expect(Object.keys(sortResolutions({ head }))).toStrictEqual([
      'a',
      'a@^9.0.0',
      'a@^10.0.0',
    ]);
  });

  it('leaves packages the branch did not touch alone', () => {
    const base = { 'b@2.0.0': 'x', 'b@1.0.0': 'y', 'c@2.0.0': 'z' };
    const head = { 'b@2.0.0': 'x', 'b@1.0.0': 'y', 'c@2.0.0': 'new' };
    expect(Object.keys(sortResolutions({ base, head }))).toStrictEqual([
      'b@2.0.0',
      'b@1.0.0',
      'c@2.0.0',
    ]);
  });

  it('produces output the lint accepts', () => {
    const head = { 'x@^2.0.0': 'a', 'y@1.0.0': 'b', 'x@^1.0.0': 'c' };
    expect(lintResolutions({ head: sortResolutions({ head }) })).toStrictEqual(
      [],
    );
  });
});

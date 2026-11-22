import { lintResolutions, parseResolutionKey } from './resolutions-lint.mts';

describe('parseResolutionKey', () => {
  it.each([
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
  ])('reads %s', (key, packageName, version) => {
    expect(parseResolutionKey(key)).toMatchObject({
      packageName,
      version,
      scoped: key.includes('/') && !/^@[^/]+\/[^/]+(@.*)?$/u.test(key),
    });
  });
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

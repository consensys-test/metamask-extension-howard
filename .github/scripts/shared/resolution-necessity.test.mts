import {
  addedResolutions,
  returnedAdvisories,
  findParentUpgrade,
  formatEvidence,
  parentsOf,
  withoutResolution,
} from './resolution-necessity.mts';

describe('addedResolutions', () => {
  it('lists new and repointed pins and skips patches', () => {
    expect(
      addedResolutions(
        { 'a@npm:^1.0.0': '^1.1.0', b: '2.0.0' },
        {
          'a@npm:^1.0.0': '^1.2.0',
          b: '2.0.0',
          'c@npm:^3.0.0': '^3.1.0',
          'd@npm:^1.0.0': 'patch:d@npm%3A1.0.0#x.patch',
          'p/child': '^2.0.0',
        },
      ),
    ).toStrictEqual([
      { key: 'a@npm:^1.0.0', value: '^1.2.0', packageName: 'a' },
      { key: 'c@npm:^3.0.0', value: '^3.1.0', packageName: 'c' },
      { key: 'p/child', value: '^2.0.0', packageName: 'child' },
    ]);
  });
});

describe('withoutResolution', () => {
  it('drops only the named key', () => {
    expect(withoutResolution({ a: '1', b: '2' }, 'a')).toStrictEqual({
      b: '2',
    });
  });
});

describe('returnedAdvisories', () => {
  const trial = [
    '{"value":"postcss","children":{"ID":1,"Issue":"x","URL":"https://github.com/advisories/GHSA-aaaa","Severity":"moderate"}}',
    '',
    '{"value":"ws","children":{"ID":2,"Issue":"y","URL":"https://github.com/advisories/GHSA-bbbb"}}',
  ].join('\n');

  const baseline =
    '{"value":"ws","children":{"ID":2,"Issue":"y","URL":"https://github.com/advisories/GHSA-bbbb"}}';

  it('lists advisories, in any package, that the baseline lacks', () => {
    expect(returnedAdvisories(trial, baseline)).toStrictEqual([
      'postcss GHSA-aaaa',
    ]);
    expect(returnedAdvisories(baseline, trial)).toStrictEqual([]);
    expect(returnedAdvisories('', baseline)).toStrictEqual([]);
  });
});

describe('parentsOf', () => {
  it('finds lockfile entries that depend on the package', () => {
    const entries = [
      {
        name: 'got',
        version: '9.6.0',
        descriptors: ['got@npm:^9.6.0'],
        dependencies: { 'p-cancelable': '^1.0.0' },
      },
      {
        name: 'x',
        version: '1.0.0',
        descriptors: ['@s/x@npm:^1.0.0'],
        dependencies: { got: '^9.0.0' },
      },
    ];

    expect(parentsOf(entries, 'got')).toStrictEqual([
      { name: '@s/x', version: '1.0.0', range: '^9.0.0' },
    ]);
  });
});

describe('findParentUpgrade', () => {
  const versions = [
    { version: '1.0.0', range: '^0.5.0' },
    { version: '1.1.0', range: '^0.5.0' },
    { version: '2.0.0-beta.1', range: '^0.6.0' },
    { version: '2.0.0', range: '^0.6.0' },
    { version: '2.1.0', range: undefined },
    { version: '3.0.0', range: '^0.6.1' },
  ];

  it('picks the lowest newer stable version that accepts the fixed one', () => {
    expect(
      findParentUpgrade({ versions, current: '1.0.0', fixedVersion: '0.6.2' }),
    ).toBe('2.0.0');
  });

  it('accepts a range that starts above the fixed version', () => {
    expect(
      findParentUpgrade({ versions, current: '1.0.0', fixedVersion: '0.6.0' }),
    ).toBe('2.0.0');
    expect(
      findParentUpgrade({
        versions: [{ version: '2.0.0', range: '^8.1.0' }],
        current: '1.0.0',
        fixedVersion: '7.0.0',
      }),
    ).toBe('2.0.0');
  });

  it('returns undefined when no parent version accepts it', () => {
    expect(
      findParentUpgrade({ versions, current: '1.0.0', fixedVersion: '0.9.0' }),
    ).toBeUndefined();
  });
});

describe('formatEvidence', () => {
  const resolution = { key: 'p@npm:^1.0.0', value: '^2.0.0', packageName: 'p' };

  it('says when the resolution is not needed', () => {
    expect(
      formatEvidence({
        resolution,
        trial: { advisories: [], resolvedVersions: ['2.1.0'] },
        parentUpgrades: [],
      }),
    ).toContain('not needed, without it p resolves to 2.1.0');
  });

  it('names the parent upgrade for a needed resolution', () => {
    expect(
      formatEvidence({
        resolution,
        trial: { advisories: ['GHSA-a'], resolvedVersions: ['1.0.0'] },
        parentUpgrades: ['q 1.0.0 -> 2.0.0'],
      }),
    ).toBe(
      '- `p@npm:^1.0.0` -> `^2.0.0`: needed, without it 1 advisory(ies) return (GHSA-a); avoidable by upgrading q 1.0.0 -> 2.0.0.',
    );
  });
});

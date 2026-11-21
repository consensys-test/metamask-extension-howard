import {
  findBlockers,
  findConsumers,
  newestSafeInRange,
  parentFixes,
  renderConsumerReport,
  safeLines,
  sameLine,
  type PackageInfo,
} from './audit-consumers.mts';
import { parseLockfile } from './lockfile-churn.mts';

const NOW = Date.parse('2026-11-18T00:00:00Z');
const hoursAgo = (hours: number): number => NOW - hours * 3_600_000;
const clock = { now: NOW, gateHours: 72 };
const vulnerable = ['>=7.0.0 <11.0.1'];

const info = (
  versions: [string, number, Record<string, string>?][],
): PackageInfo => ({
  versions: versions.map(([version, age, ranges = {}]) => ({
    version,
    publishedAt: hoursAgo(age),
    ranges,
  })),
});

const minimatch = info([
  ['5.1.9', 9000],
  ['7.4.9', 5000],
  ['10.2.6', 3000],
  ['11.0.8', 200],
  ['11.0.9', 49],
]);

const entry = (
  descriptors: string,
  version: string,
  dependencies: Record<string, string> = {},
): string => {
  const deps = Object.entries(dependencies)
    .map(([name, range]) => `    ${name}: "${range}"`)
    .join('\n');
  return [
    `"${descriptors}":`,
    `  version: ${version}`,
    ...(deps ? ['  dependencies:', deps] : []),
    '  languageName: node',
  ].join('\n');
};

const lock = parseLockfile(
  [
    '__metadata:\n  version: 8\n',
    entry('minimatch@npm:^7.4.6', '7.4.9'),
    entry('minimatch@npm:^10.0.1', '10.2.6'),
    entry('minimatch@npm:^11.0.2', '11.0.8'),
    entry('depcheck@npm:^1.4.7', '1.4.7', { minimatch: 'npm:^7.4.6' }),
    entry('ts-common@npm:~0.29.0', '0.29.0', { minimatch: 'npm:^10.0.1' }),
    entry('ts-morph@npm:^28.0.0', '28.0.0', { 'ts-common': 'npm:~0.29.0' }),
    entry('glob@npm:^14.0.0', '14.0.3', { minimatch: 'npm:^11.0.2' }),
  ].join('\n\n'),
);

describe('findConsumers', () => {
  it('lists parents whose range resolves to an affected version', () => {
    expect(
      findConsumers(lock, 'minimatch', vulnerable).map(
        ({ parent, range, resolved }) => [parent, range, resolved],
      ),
    ).toStrictEqual([
      ['depcheck', '^7.4.6', '7.4.9'],
      ['ts-common', '^10.0.1', '10.2.6'],
    ]);
  });
});

describe('newestSafeInRange', () => {
  it('returns the newest unaffected release inside the range, with its age', () => {
    expect(
      newestSafeInRange('^11.0.2', minimatch, vulnerable, clock),
    ).toStrictEqual({
      version: '11.0.9',
      ageHours: 49,
      gated: true,
      requires: '^11.0.2',
    });
  });

  it('returns nothing when the range only reaches affected releases', () => {
    expect(
      newestSafeInRange('^7.4.6', minimatch, vulnerable, clock),
    ).toBeUndefined();
  });
});

describe('parentFixes', () => {
  const consumer = {
    parent: 'ts-common',
    parentVersion: '0.29.0',
    range: '^10.0.1',
    resolved: '10.2.6',
  };

  it('finds the first newer release on the same line and flags the age gate', () => {
    const parent = info([
      ['0.29.0', 5000, { minimatch: '^10.0.1' }],
      ['0.29.1', 51, { minimatch: '^11.0.1' }],
      ['0.30.0', 10, { minimatch: '^11.0.1' }],
    ]);

    const fixes = parentFixes(
      parent,
      consumer,
      'minimatch',
      minimatch,
      vulnerable,
      clock,
    );

    expect(fixes.sameLine).toStrictEqual({
      version: '0.29.1',
      ageHours: 51,
      gated: true,
      requires: '^11.0.1',
    });
    expect(fixes.anyLine?.version).toBe('0.29.1');
  });

  it('reports a fix on another line when the parent line has none', () => {
    const parent = info([
      ['7.18.0', 5000, { minimatch: '^9.0.4' }],
      ['8.73.0', 55, { minimatch: '^11.0.1' }],
    ]);

    const fixes = parentFixes(
      parent,
      { ...consumer, parent: 'estree', parentVersion: '7.18.0' },
      'minimatch',
      minimatch,
      vulnerable,
      clock,
    );

    expect(fixes.sameLine).toBeUndefined();
    expect(fixes.anyLine?.version).toBe('8.73.0');
  });

  it('treats a release that drops the dependency as a fix', () => {
    const parent = info([
      ['10.38.0', 5000, { minimatch: '^9.0.0' }],
      ['10.60.0', 4000],
    ]);

    const fixes = parentFixes(
      parent,
      { ...consumer, parent: 'sentry', parentVersion: '10.38.0' },
      'minimatch',
      minimatch,
      vulnerable,
      clock,
    );

    expect(fixes.sameLine).toMatchObject({
      version: '10.60.0',
      requires: 'none',
    });
  });
});

describe('findBlockers', () => {
  it('lists requirers whose range excludes the fixed release', () => {
    expect(findBlockers(lock, 'ts-common', '0.29.1')).toStrictEqual([]);
    expect(findBlockers(lock, 'ts-common', '0.30.0')).toStrictEqual([
      { name: 'ts-morph', version: '28.0.0', range: '~0.29.0' },
    ]);
  });
});

describe('safeLines', () => {
  it('keeps the newest release of each line the advisory does not cover', () => {
    expect(
      safeLines(minimatch, vulnerable, clock).map(({ version }) => version),
    ).toStrictEqual(['5.1.9', '11.0.9']);
  });
});

describe('sameLine', () => {
  it('compares majors, and minors below 1.0', () => {
    expect(sameLine('8.62.0', '8.73.0')).toBe(true);
    expect(sameLine('7.18.0', '8.73.0')).toBe(false);
    expect(sameLine('0.29.0', '0.29.1')).toBe(true);
    expect(sameLine('0.29.0', '0.30.0')).toBe(false);
  });
});

describe('renderConsumerReport', () => {
  it('marks a fix inside the age gate', () => {
    const report = renderConsumerReport(
      [
        {
          pkg: 'minimatch',
          vulnerable,
          safeLines: [],
          installedSafe: ['5.1.9', '11.0.9'],
          rows: [
            {
              consumer: {
                parent: 'ts-common',
                parentVersion: '0.29.0',
                range: '^10.0.1',
                resolved: '10.2.6',
              },
              fixes: {
                sameLine: {
                  version: '0.29.1',
                  ageHours: 51,
                  gated: true,
                  requires: '^11.0.1',
                },
              },
              blockers: [],
            },
          ],
        },
      ],
      72,
    );

    expect(report).toContain('0.29.1 (needs `^11.0.1`, 51 h old, **inside');
    expect(report).toContain('--preapprove');
    expect(report).toContain('already in `yarn.lock`');
    expect(report).toContain('5.1.9, 11.0.9');
  });
});

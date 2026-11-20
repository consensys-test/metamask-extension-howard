import {
  computeChurn,
  parseLockfile,
  productionPackages,
  riskyChanges,
} from './lockfile-churn.mts';

const lock = (blocks: string[]): string =>
  ['__metadata:\n  version: 8\n', ...blocks].join('\n\n');

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

const rootDependencies = { app: '^1.0.0' };

describe('parseLockfile', () => {
  it('reads names, versions, descriptors and dependencies', () => {
    const entries = parseLockfile(
      lock([
        entry('app@npm:^1.0.0, app@npm:^1.1.0', '1.1.0', { ws: 'npm:^8.0.0' }),
        entry('@scope/pkg@npm:^2.0.0', '2.0.1'),
      ]),
    );

    expect(entries).toStrictEqual([
      {
        name: 'app',
        version: '1.1.0',
        descriptors: ['app@npm:^1.0.0', 'app@npm:^1.1.0'],
        dependencies: { ws: 'npm:^8.0.0' },
      },
      {
        name: '@scope/pkg',
        version: '2.0.1',
        descriptors: ['@scope/pkg@npm:^2.0.0'],
        dependencies: {},
      },
    ]);
  });
});

describe('productionPackages', () => {
  it('follows root dependencies and excludes dev-only packages', () => {
    const entries = parseLockfile(
      lock([
        entry('app@npm:^1.0.0', '1.0.0', { ws: 'npm:^8.0.0' }),
        entry('ws@npm:^8.0.0', '8.1.0'),
        entry('jest@npm:^29.0.0', '29.0.0', { ws: 'npm:^8.0.0' }),
      ]),
    );

    expect(productionPackages(entries, rootDependencies)).toStrictEqual(
      new Set(['app', 'ws']),
    );
  });

  it('falls back to the package name when a resolution rewrote the descriptor', () => {
    const entries = parseLockfile(
      lock([
        entry('app@npm:^1.0.0', '1.0.0', { ws: 'npm:^7.0.0' }),
        entry('ws@npm:8.1.0', '8.1.0'),
      ]),
    );

    expect(productionPackages(entries, rootDependencies).has('ws')).toBe(true);
  });
});

describe('computeChurn', () => {
  const before = parseLockfile(
    lock([
      entry('app@npm:^1.0.0', '1.0.0', { ws: 'npm:^8.0.0' }),
      entry('ws@npm:^8.0.0', '8.1.0'),
      entry('jest-preview@npm:^1.0.0', '1.0.0'),
    ]),
  );
  const after = parseLockfile(
    lock([
      entry('app@npm:^1.0.0', '1.0.0', { ws: 'npm:^8.0.0' }),
      entry('ws@npm:^8.0.0', '8.2.2'),
      entry('jest-preview@npm:^1.0.0', '1.1.0'),
    ]),
  );

  it('flags an untargeted production package that moved', () => {
    const changes = computeChurn({
      before,
      after,
      targets: new Set(['jest-preview']),
      rootDependencies,
    });

    expect(changes.map((change) => change.name)).toStrictEqual([
      'jest-preview',
      'ws',
    ]);
    expect(riskyChanges(changes).map((change) => change.name)).toStrictEqual([
      'ws',
    ]);
  });

  it('reports nothing when the lockfiles match', () => {
    expect(
      computeChurn({
        before,
        after: before,
        targets: new Set(),
        rootDependencies,
      }),
    ).toStrictEqual([]);
  });

  it('does not flag a targeted package, even in production', () => {
    const changes = computeChurn({
      before,
      after,
      targets: new Set(['ws', 'jest-preview']),
      rootDependencies,
    });

    expect(riskyChanges(changes)).toStrictEqual([]);
  });
});

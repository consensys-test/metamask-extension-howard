import {
  deadPins,
  splitResolutionKey,
  unreferencedPatches,
} from './dead-pins.mts';
import type { LockEntry } from './lockfile-churn.mts';

const entry = (name: string, dependencies: Record<string, string>) =>
  ({
    name,
    version: '1.0.0',
    descriptors: [`${name}@npm:^1.0.0`],
    dependencies,
  }) as LockEntry;

describe('splitResolutionKey', () => {
  it('reads a plain name and a name with a range', () => {
    expect(splitResolutionKey('a')).toStrictEqual({
      parent: undefined,
      name: 'a',
      range: undefined,
    });
    expect(splitResolutionKey('a@npm:^1.0.0')).toStrictEqual({
      parent: undefined,
      name: 'a',
      range: '^1.0.0',
    });
  });

  it('reads scoped package names', () => {
    expect(splitResolutionKey('@s/a@npm:1.2.3')).toStrictEqual({
      parent: undefined,
      name: '@s/a',
      range: '1.2.3',
    });
  });

  it('reads parent keys', () => {
    expect(splitResolutionKey('p/c')).toStrictEqual({
      parent: 'p',
      name: 'c',
      range: undefined,
    });
    expect(splitResolutionKey('@s/p/c')?.parent).toBe('@s/p');
    expect(splitResolutionKey('**/c')?.parent).toBe('**');
  });
});

describe('deadPins', () => {
  const entries = [
    entry('x', { minimatch: 'npm:^9.0.4', zod: 'npm:3.22.4' }),
    entry('y', { glob: 'npm:^10.0.0' }),
  ];
  const base = {
    entries,
    rootName: 'root',
    rootDependencies: { ws: '^8.0.0' },
  };

  it('keeps pins that a dependency still matches', () => {
    expect(
      deadPins({
        ...base,
        resolutions: {
          'minimatch@npm:^9.0.4': '^11.0.3',
          'zod@npm:3.22.4': '^4.6.7',
          'ws@npm:^8.0.0': '^8.21.0',
          glob: '^11.0.0',
        },
      }),
    ).toStrictEqual([]);
  });

  it('lists pins whose range or package nobody asks for', () => {
    expect(
      deadPins({
        ...base,
        resolutions: {
          'minimatch@npm:^10.1.1': '^10.2.5',
          'minimatch@npm:9.0.3': '^9.0.9',
          'left-pad': '1.3.0',
          'minimatch@npm:^9.0.4': '^11.0.3',
        },
      }),
    ).toStrictEqual([
      'minimatch@npm:^10.1.1',
      'minimatch@npm:9.0.3',
      'left-pad',
    ]);
  });

  it('matches scoped keys by their parent', () => {
    expect(
      deadPins({
        ...base,
        resolutions: {
          'x/minimatch': '^11.0.3',
          'y/minimatch': '^11.0.3',
          '**/zod': '^4.6.7',
        },
      }),
    ).toStrictEqual(['y/minimatch']);
  });

  it('never calls a key dead when it has a parent range or an unknown shape', () => {
    expect(
      deadPins({
        ...base,
        resolutions: {
          'gone@npm:^1.0.0/minimatch': '^11.0.3',
          '/': '1',
        },
      }),
    ).toStrictEqual([]);
  });
});

describe('unreferencedPatches', () => {
  it('lists patch files that no text mentions', () => {
    expect(
      unreferencedPatches(
        ['a-1.patch', 'b-2.patch'],
        ['"x": "patch:x#~/.yarn/patches/a-1.patch"', 'unrelated'],
      ),
    ).toStrictEqual(['b-2.patch']);
  });
});

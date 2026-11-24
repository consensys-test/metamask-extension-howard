import {
  logExcerpt,
  packageJsonChanges,
  renderRows,
} from './audit-repair-inputs.mts';
import type { PackageChange } from './lockfile-churn.mts';

const numbered = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `line ${index}`);

describe('logExcerpt', () => {
  it('centres the excerpt on the heap error and drops timestamps and colours', () => {
    const log = [
      ...numbered(100).map((line) => `2026-11-20T06:19:57.1234567Z ${line}`),
      '2026-11-20T06:19:57.2706669Z FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
      ...numbered(100),
    ].join('\n');

    const excerpt = logExcerpt(log, 50).split('\n');

    expect(excerpt).toHaveLength(50);
    expect(excerpt[10]).toMatch(/^FATAL ERROR/u);
    expect(excerpt[0]).toBe('line 90');
  });

  it('prefers the heap line over an earlier generic error', () => {
    const log = [
      '##[error]earlier',
      ...numbered(80),
      'JavaScript heap out of memory',
    ].join('\n');

    expect(logExcerpt(log, 10)).toContain('JavaScript heap out of memory');
  });

  it('gives the tail when nothing looks like a cause', () => {
    const excerpt = logExcerpt(numbered(100).join('\n'), 5);

    expect(excerpt).toBe('line 95\nline 96\nline 97\nline 98\nline 99');
  });

  it('removes ANSI colour codes', () => {
    expect(logExcerpt('\u001b[31mError: boom\u001b[0m', 5)).toBe('Error: boom');
  });
});

describe('packageJsonChanges', () => {
  it('lists added, removed and repointed entries in the dependency sections', () => {
    const changes = packageJsonChanges(
      {
        devDependencies: { eslint: '^9.0.0', gone: '1.0.0' },
        resolutions: { 'a@npm:^1': '^1.1.0' },
      },
      {
        devDependencies: { eslint: '^9.1.0', fresh: '2.0.0' },
        resolutions: { 'a@npm:^1': '^1.1.0' },
      },
    ).map(({ line }) => line);

    expect(changes).toStrictEqual([
      'devDependencies: `eslint` ^9.0.0 -> ^9.1.0',
      'devDependencies: `gone` removed (was 1.0.0)',
      'devDependencies: `fresh` added 2.0.0',
    ]);
  });
});

describe('renderRows', () => {
  const change = (
    name: string,
    before: string[],
    after: string[],
    majorJump = false,
  ): PackageChange => ({
    name,
    before,
    after,
    targeted: false,
    production: false,
    reachable: false,
    majorJump,
    extraVersion: false,
  });

  it('groups lockfile changes by toolchain family and keeps other packages last', () => {
    const report = renderRows(
      [{ line: 'devDependencies: `typescript-eslint` ^8.62.0 -> ^8.73.0' }],
      [
        change('zod', ['3.0.0'], ['4.0.0'], true),
        change('@typescript-eslint/parser', ['8.62.0'], ['8.73.0']),
        change('@typescript-eslint/utils', ['8.62.0'], ['8.73.0']),
      ],
    );

    expect(report).toContain('### typescript-eslint (2 packages)');
    expect(report).toContain('- `@typescript-eslint/parser`: 8.62.0 -> 8.73.0');
    expect(report).toContain('- `zod`: 3.0.0 -> 4.0.0 (major jump)');
    expect(report.indexOf('### typescript-eslint')).toBeLessThan(
      report.indexOf('### other'),
    );
  });

  it('shortens a long other group', () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      change(`pkg-${index}`, ['1.0.0'], ['1.0.1']),
    );

    expect(renderRows([], many)).toContain('- ... and 5 more');
  });
});

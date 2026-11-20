import {
  buildPrBody,
  classifyPaths,
  parsePorcelain,
  selectIssues,
  stripClosingKeywords,
} from './audit-autofix.mts';

describe('parsePorcelain', () => {
  it('reads modified, untracked and renamed entries', () => {
    expect(
      parsePorcelain(
        [
          ' M package.json',
          '?? .bashrc',
          'R  old.txt -> new.txt',
          'A  "quoted name.txt"',
          '',
        ].join('\n'),
      ),
    ).toStrictEqual([
      { path: 'package.json', untracked: false },
      { path: '.bashrc', untracked: true },
      { path: 'old.txt', untracked: false },
      { path: 'new.txt', untracked: false },
      { path: 'quoted name.txt', untracked: false },
    ]);
  });
});

describe('classifyPaths', () => {
  it('allows the dependency files and separates sandbox leftovers', () => {
    const result = classifyPaths(
      parsePorcelain(
        [
          ' M package.json',
          ' M yarn.lock',
          '?? .yarn/patches/dompurify-npm-3.4.17-abc.patch',
          ' M lavamoat/webpack/mv3/main/policy.json',
          '?? .bashrc',
          '?? .gitconfig',
          ' M app/scripts/background.js',
          ' M .yarnrc.yml',
          '?? sub/.bashrc',
        ].join('\n'),
      ),
    );

    expect(result.allowed).toStrictEqual([
      'package.json',
      'yarn.lock',
      '.yarn/patches/dompurify-npm-3.4.17-abc.patch',
      'lavamoat/webpack/mv3/main/policy.json',
    ]);
    expect(result.leftovers).toStrictEqual(['.bashrc', '.gitconfig']);
    expect(result.forbidden).toStrictEqual([
      'app/scripts/background.js',
      '.yarnrc.yml',
      'sub/.bashrc',
    ]);
  });

  it('does not excuse a tracked dotfile edit', () => {
    expect(
      classifyPaths([{ path: '.bashrc', untracked: false }]).forbidden,
    ).toStrictEqual(['.bashrc']);
  });
});

describe('stripClosingKeywords', () => {
  it('drops lines that would close issues', () => {
    expect(
      stripClosingKeywords(
        'Fixed dompurify.\nFixes: #1\n- Closes #2\nresolves https://x/#3\nKept line',
      ),
    ).toBe('Fixed dompurify.\nKept line');
  });
});

describe('buildPrBody', () => {
  const body = buildPrBody({
    runUrl: 'https://github.com/o/r/actions/runs/1',
    closes: 'Closes: #10\nNot closed: #11',
    report: 'Bumped dompurify.\nFixes: #99',
    advisoriesBefore: 5,
    advisoriesAfter: 2,
    necessityLines: ['- `a@npm:^1` -> `^2`: needed.'],
    deadPinLines: [],
    churnLines: ['- child: 1.0.0 -> 2.0.0 [production] [major jump]'],
    ageGateBypassed: ['dompurify'],
    costUsd: 1.234,
  });

  it('carries the evidence and the computed Closes lines', () => {
    expect(body).toContain('Closes: #10');
    expect(body).toContain('5 before, 2 after');
    expect(body).toContain('bypassed for: dompurify');
    expect(body).toContain('**LLM spend:** approximately $1.23');
    expect(body.indexOf('LLM spend')).toBeLessThan(
      body.indexOf('### Evidence'),
    );
    expect(body).toContain('  - `a@npm:^1` -> `^2`: needed.');
    expect(body).toContain(
      '  - child: 1.0.0 -> 2.0.0 [production] [major jump]',
    );
    expect(body).toContain('CHANGELOG entry: null');
    expect(body).toContain('Not run by the workflow');
  });

  it('does not let the agent report add closing keywords', () => {
    expect(body).not.toContain('#99');
  });

  it('lists removed dead pins only when there are some', () => {
    const input = {
      runUrl: 'u',
      closes: '',
      report: 'r',
      advisoriesBefore: 1,
      advisoriesAfter: 0,
      necessityLines: [],
      churnLines: [],
      ageGateBypassed: [],
      costUsd: undefined,
    };
    expect(buildPrBody({ ...input, deadPinLines: [] })).not.toContain(
      'Cleaned up',
    );
    expect(
      buildPrBody({ ...input, deadPinLines: ['- Removed dead pin `a`.'] }),
    ).toContain('  - Removed dead pin `a`.');
  });
});

describe('selectIssues', () => {
  const issues = [
    {
      number: 1,
      title: 'Yarn Audit: new or newly blocking advisories on main',
      body: '',
    },
    {
      number: 2,
      title: 'Yarn Audit: new or newly blocking advisories on main',
      body: '',
    },
    { number: 3, title: 'Something else', body: '' },
  ];

  it('takes every audit issue for "open"', () => {
    expect(
      selectIssues(issues, 'open').map(({ number }) => number),
    ).toStrictEqual([1, 2]);
  });

  it('takes the listed numbers and ignores non-audit issues', () => {
    expect(
      selectIssues(issues, '#2, 3, x').map(({ number }) => number),
    ).toStrictEqual([2]);
  });
});

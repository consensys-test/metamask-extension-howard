import {
  buildPrBody,
  autofixRunIds,
  buildPrSection,
  missingEarlierItems,
  reportItems,
  sameBody,
  classifyPaths,
  mentionedIssues,
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

describe('buildPrSection', () => {
  const section = buildPrSection({
    runUrl: 'https://github.com/o/r/actions/runs/2',
    closes: 'Closes: #20',
    report: 'Bumped nanoid.\nFixes: #98',
    advisoriesBefore: 3,
    advisoriesAfter: 2,
    necessityLines: [],
    deadPinLines: [],
    churnLines: [],
    ageGateBypassed: [],
    costUsd: 0.5,
  });

  it('adds the run, its spend and its Closes line under one heading', () => {
    expect(section).toContain('### Added by the [audit autofix run]');
    expect(section).toContain('**LLM spend:** approximately $0.50');
    expect(section).toContain('Closes: #20');
    expect(section).toContain('3 before, 2 after');
  });

  it('strips closing keywords the agent wrote itself', () => {
    expect(section).not.toContain('Fixes: #98');
  });
});

describe('buildPrBody over several runs', () => {
  const input = {
    runUrl: 'https://x/runs/3',
    runUrls: ['https://x/runs/1', 'https://x/runs/3'],
    closes: 'Closes: #1',
    report: 'r',
    advisoriesBefore: 5,
    advisoriesAfter: 1,
    necessityLines: [],
    deadPinLines: [],
    churnLines: [],
    ageGateBypassed: [],
    costUsd: 2.5,
  };

  it('links every run and sums the spend over them', () => {
    const body = buildPrBody(input);
    expect(body).toContain(
      '([run 1](https://x/runs/1), [run 2](https://x/runs/3))',
    );
    expect(body).toContain('approximately $2.50 in total over 2 autofix runs');
    expect(body).toContain('5 before, 1 after');
  });

  it('keeps the single-run wording without runUrls', () => {
    const body = buildPrBody({ ...input, runUrls: undefined });
    expect(body).toContain('[audit autofix workflow](https://x/runs/3)');
    expect(body).not.toContain('in total over');
  });
});

describe('autofixRunIds', () => {
  it('reads the trailers oldest first and skips repeats and other commits', () => {
    expect(
      autofixRunIds([
        'bump: fix audit advisories\n\nAudit-Autofix: 11',
        'bump: repair audit fix (lavamoat-policy)',
        'bump: fix audit advisories\n\nAudit-Autofix: 22\n',
        'again\n\nAudit-Autofix: 11',
      ]),
    ).toStrictEqual(['11', '22']);
  });
});

describe('missingEarlierItems', () => {
  const earlier =
    '### B\n- **fast-xml-parser** (low)\n  - **not a package line**\n- **hono** (low)\n\n### C\n- **nanoid** (high)\n';

  it('lists items at any depth', () => {
    expect(reportItems(earlier)).toStrictEqual([
      'fast-xml-parser',
      'not a package line',
      'hono',
      'nanoid',
    ]);
  });

  it('finds the items a merged report dropped', () => {
    const merged =
      '### B\n- **fast-xml-parser** (low)\n- **hono** (low)\n- **nanoid** (high)\n  - **not a package line**\n- **new-one** (low)\n';
    expect(missingEarlierItems(earlier, merged)).toStrictEqual([]);
    expect(missingEarlierItems(earlier, '- **hono** (low)\n')).toStrictEqual([
      'fast-xml-parser',
      'not a package line',
      'nanoid',
    ]);
  });
});

describe('sameBody', () => {
  it('ignores CRLF and surrounding whitespace', () => {
    expect(sameBody('a\r\nb\r\n', 'a\nb')).toBe(true);
    expect(sameBody('a\nb', 'a\nc')).toBe(false);
  });
});

describe('mentionedIssues', () => {
  it('collects every issue number in a PR body', () => {
    expect(
      mentionedIssues('Closes: #10\nNot closed: #11\nsee #10'),
    ).toStrictEqual(new Set([10, 11]));
    expect(mentionedIssues('nothing here')).toStrictEqual(new Set());
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

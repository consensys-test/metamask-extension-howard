import {
  computeCloses,
  formatClosesMarkdown,
  parseIssueAdvisories,
} from './audit-closes.mts';
import type { ParsedAdvisory } from './audit-utils.mts';

const OTEL_URL = 'https://github.com/advisories/GHSA-3v2p-hm54-8qcq';
const HONO_URL = 'https://github.com/advisories/GHSA-rmxm-3fg6-px4f';

// Shape of a real bot issue (#47956), trimmed.
const singleAdvisoryBody = `**1** new or newly blocking advisory detected on push to \`main\` (0 release-blocking).

## Informational (dev-only or low severity)

- **@opentelemetry/instrumentation-http** (moderate, dev-only) — OpenTelemetry JavaScript: Insertion of Sensitive Information into Log File
  ${OTEL_URL}

<details><summary>Native audit tree</summary>

\`\`\`
├─ @opentelemetry/instrumentation-http
│  ├─ URL: ${OTEL_URL}
\`\`\`
</details>`;

const twoAdvisoryBody = `## Release-blocking (production, moderate+)

- **@hono/node-server** (moderate) — serveStatic decodes the request path twice
  ${HONO_URL}

## Informational (dev-only or low severity)

- **popper.js** (low, dev-only) — popper.js is deprecated
`;

const advisory = (
  moduleName: string,
  url: string,
  title = 'x',
): ParsedAdvisory => ({
  id: 1,
  moduleName,
  title,
  url,
  vulnerableVersions: '*',
  patchedVersions: '',
  originalSeverity: 'moderate',
  effectiveSeverity: 'moderate',
  isDevOnly: false,
  affectsProduction: true,
  matchedIssueRule: 'none',
  treeVersions: [],
  dependents: [],
});

describe('parseIssueAdvisories', () => {
  it('reads advisories from the list and ignores the native audit tree', () => {
    const refs = parseIssueAdvisories(singleAdvisoryBody);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      moduleName: '@opentelemetry/instrumentation-http',
      url: OTEL_URL,
    });
  });

  it('keeps an entry that has no URL line', () => {
    const refs = parseIssueAdvisories(twoAdvisoryBody);

    expect(refs.map((ref) => ref.moduleName)).toStrictEqual([
      '@hono/node-server',
      'popper.js',
    ]);
    expect(refs[1].url).toBe('');
  });

  it('returns nothing for a body without advisories', () => {
    expect(parseIssueAdvisories('Some other issue')).toStrictEqual([]);
  });
});

describe('computeCloses', () => {
  it('closes an issue whose advisories are all gone', () => {
    const [decision] = computeCloses(
      [{ number: 1, body: singleAdvisoryBody }],
      [],
    );

    expect(decision).toMatchObject({ number: 1, closes: true, remaining: [] });
  });

  it('keeps an issue open while one of its advisories is still reported', () => {
    const [decision] = computeCloses(
      [{ number: 2, body: twoAdvisoryBody }],
      [advisory('@hono/node-server', HONO_URL)],
    );

    expect(decision.closes).toBe(false);
    expect(decision.remaining).toStrictEqual([
      `@hono/node-server: ${HONO_URL}`,
    ]);
  });

  it('matches by advisory, not by package name', () => {
    const [decision] = computeCloses(
      [{ number: 3, body: singleAdvisoryBody }],
      [
        advisory(
          '@opentelemetry/instrumentation-http',
          'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        ),
      ],
    );

    expect(decision.closes).toBe(true);
  });

  it('never closes an issue it could not parse', () => {
    const [decision] = computeCloses([{ number: 4, body: 'no list here' }], []);

    expect(decision.closes).toBe(false);
    expect(decision.advisoryCount).toBe(0);
  });
});

describe('formatClosesMarkdown', () => {
  it('lists Closes lines, then why the others stay open', () => {
    const markdown = formatClosesMarkdown(
      computeCloses(
        [
          { number: 1, body: singleAdvisoryBody },
          { number: 2, body: twoAdvisoryBody },
        ],
        [advisory('@hono/node-server', HONO_URL)],
      ),
    );

    expect(markdown).toBe(
      [
        'Closes: #1',
        '',
        'Not closed:',
        `- #2: 1 of 2 still reported (@hono/node-server: ${HONO_URL})`,
      ].join('\n'),
    );
  });
});

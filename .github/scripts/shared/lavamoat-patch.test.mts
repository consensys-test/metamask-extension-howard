import {
  hashMismatches,
  parsePatchFiles,
  unexpectedPaths,
} from './lavamoat-patch.mts';

const PATCH = [
  'diff --git a/lavamoat/webpack/mv2/beta/policy.json b/lavamoat/webpack/mv2/beta/policy.json',
  'index d3752ecbe2f..1a8100a35c5 100644',
  '--- a/lavamoat/webpack/mv2/beta/policy.json',
  '+++ b/lavamoat/webpack/mv2/beta/policy.json',
  '@@ -1,1 +1,1 @@',
  '-a',
  '+b',
  'diff --git a/lavamoat/webpack/mv2/flask/policy.json b/lavamoat/webpack/mv2/flask/policy.json',
  'index d3752ecbe2f..2b9100a35c5 100644',
  '--- a/lavamoat/webpack/mv2/flask/policy.json',
  '+++ b/lavamoat/webpack/mv2/flask/policy.json',
].join('\n');

describe('parsePatchFiles', () => {
  it('reads the path and the new blob of every file', () => {
    expect(parsePatchFiles(PATCH)).toStrictEqual([
      {
        path: 'lavamoat/webpack/mv2/beta/policy.json',
        newBlob: '1a8100a35c5',
        deleted: false,
      },
      {
        path: 'lavamoat/webpack/mv2/flask/policy.json',
        newBlob: '2b9100a35c5',
        deleted: false,
      },
    ]);
  });

  it('marks deleted files and accepts CRLF', () => {
    const patch = [
      'diff --git a/lavamoat/webpack/x/policy.json b/lavamoat/webpack/x/policy.json',
      'deleted file mode 100644',
      'index abc1234..0000000',
    ].join('\r\n');

    expect(parsePatchFiles(patch)).toMatchObject([{ deleted: true }]);
  });

  it('returns nothing for an empty patch', () => {
    expect(parsePatchFiles('')).toStrictEqual([]);
  });
});

describe('unexpectedPaths', () => {
  it('lists files that are not webpack policies', () => {
    const files = parsePatchFiles(
      `${PATCH}\ndiff --git a/package.json b/package.json\nindex 111..222 100644`,
    );

    expect(unexpectedPaths(files)).toStrictEqual(['package.json']);
  });
});

describe('hashMismatches', () => {
  it('reports files whose hash differs and skips deleted ones', () => {
    const files = parsePatchFiles(PATCH);

    expect(
      hashMismatches(files, (path) =>
        path.includes('beta') ? '1a8100a35c5ffff' : 'deadbeef',
      ).map(({ path }) => path),
    ).toStrictEqual(['lavamoat/webpack/mv2/flask/policy.json']);
    expect(
      hashMismatches([{ ...files[0], deleted: true }], () => 'x'),
    ).toStrictEqual([]);
  });
});

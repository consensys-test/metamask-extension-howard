import {
  buildReply,
  newestThread,
  parseSlackMarker,
  slackMarker,
} from './audit-slack.mts';

const thread = { channel: 'C08P4QQCWG1', ts: '1795570269.196879' };

describe('slackMarker', () => {
  it('round-trips through parseSlackMarker', () => {
    expect(parseSlackMarker(`Posted.\n${slackMarker(thread)}`)).toStrictEqual(
      thread,
    );
  });

  it('ignores a comment without a marker', () => {
    expect(parseSlackMarker('looks good')).toBeUndefined();
  });
});

describe('newestThread', () => {
  it('takes the highest issue number that has a thread', () => {
    const older = { channel: 'C1', ts: '1.1' };
    expect(
      newestThread([
        { number: 5, comments: [slackMarker(older)] },
        { number: 9, comments: ['no marker here'] },
        { number: 7, comments: ['hi', slackMarker(thread)] },
      ]),
    ).toStrictEqual({ issue: 7, ...thread });
  });

  it('returns nothing when no issue has a thread', () => {
    expect(newestThread([{ number: 1, comments: [] }])).toBeUndefined();
  });
});

describe('buildReply', () => {
  const base = {
    prNumber: 12,
    prUrl: 'https://github.com/o/r/pull/12',
    statusUrl: 'https://github.com/o/r/pull/12#issuecomment-1',
  };

  it('announces an opened PR with its link', () => {
    expect(buildReply({ ...base, kind: 'opened' })).toContain(
      '<https://github.com/o/r/pull/12|#12>',
    );
  });

  it('says Main passes when the loop is done', () => {
    expect(buildReply({ ...base, kind: 'done' })).toContain('Main passes');
  });

  it('names the outcome when the loop stops', () => {
    expect(
      buildReply({ ...base, kind: 'stopped', outcome: 'needs-human' }),
    ).toContain('(needs-human)');
  });
});

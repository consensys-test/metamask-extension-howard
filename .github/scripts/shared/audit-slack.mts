// Slack side of the audit: the audit's own post records where it landed, and the autofix and
// repair workflows reply in that thread.

export type SlackThread = { channel: string; ts: string };

const MARKER = /<!-- audit-slack channel=([A-Z0-9]+) ts=(\d+\.\d+) -->/u;

/** Hidden line in a tracking-issue comment that says which Slack message announced the issue. */
export function slackMarker(thread: SlackThread): string {
  return `<!-- audit-slack channel=${thread.channel} ts=${thread.ts} -->`;
}

export function parseSlackMarker(body: string): SlackThread | undefined {
  const match = MARKER.exec(body);
  return match ? { channel: match[1], ts: match[2] } : undefined;
}

/**
 * The thread of the newest issue (highest number) that has one. A rolling PR covers several issues
 * and the newest issue is announced last, so that is the message people see.
 */
export function newestThread(
  issues: { number: number; comments: string[] }[],
): (SlackThread & { issue: number }) | undefined {
  const found = issues
    .map(({ number, comments }) => ({
      issue: number,
      thread: comments.map(parseSlackMarker).find(Boolean),
    }))
    .filter(
      (entry): entry is { issue: number; thread: SlackThread } =>
        entry.thread !== undefined,
    )
    .sort((a, b) => b.issue - a.issue)[0];
  return found && { issue: found.issue, ...found.thread };
}

export type ReplyInput = {
  kind: 'opened' | 'done' | 'stopped';
  prNumber: number;
  prUrl: string;
  /** The repair outcome, for a stopped loop. */
  outcome?: string;
  statusUrl?: string;
};

/** Links and a state only; nothing from the agent or the logs goes to Slack. */
export function buildReply(input: ReplyInput): string {
  const pr = `<${input.prUrl}|#${input.prNumber}>`;
  const status = input.statusUrl ? ` <${input.statusUrl}|Details>` : '';
  switch (input.kind) {
    case 'opened':
      return `:wrench: The audit autofix prepared draft PR ${pr} for these advisories. A human reviews and merges.${status}`;
    case 'done':
      return `:white_check_mark: Main passes on autofix PR ${pr}. It is ready for a human to review.${status}`;
    default:
      return `:warning: The audit autofix stopped on PR ${pr} (${input.outcome ?? 'unknown'}). A human is needed.${status}`;
  }
}

export type SlackPostResult = {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
};

export type SlackMessage = {
  channel: string;
  text: string;
  blocks?: object[];
  /** Set to reply in the thread of that message. */
  threadTs?: string;
};

export async function postSlackMessage(
  token: string,
  message: SlackMessage,
): Promise<SlackPostResult> {
  // Slack's field names are snake_case.
  const payload = Object.fromEntries(
    [
      ['channel', message.channel],
      ['text', message.text],
      ['blocks', message.blocks],
      ['thread_ts', message.threadTs],
      ['reply_broadcast', message.threadTs ? false : undefined],
      ['unfurl_links', false],
    ].filter(([, value]) => value !== undefined),
  );
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as SlackPostResult;
}

// Replies in the Slack thread of the audit's post about the issues the autofix PR covers.
//   node .github/scripts/audit-slack-reply.mts --kind opened|done|stopped --branch audit-autofix
//     [--outcome <name>] [--status-url <url>]
// Needs GH_TOKEN, GITHUB_REPOSITORY and SLACK_BOT_TOKEN. Never fatal: Slack is only a notification.
import { argValue } from './shared/cli.mts';
import { ghApi } from './shared/gh-api.mts';
import { mentionedIssues } from './shared/audit-autofix.mts';
import {
  buildReply,
  newestThread,
  postSlackMessage,
} from './shared/audit-slack.mts';
import type { ReplyInput } from './shared/audit-slack.mts';

function jsonLines<Shape>(text: string): Shape[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Shape);
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const branch = argValue('--branch') ?? 'audit-autofix';
  if (!token) {
    console.log('SLACK_BOT_TOKEN is not set; no Slack reply sent.');
    return;
  }

  // The `head=` filter returned nothing for a branch name with a slash, so filter the list.
  const [pr] = jsonLines<{ number: number; url: string; body: string }>(
    ghApi(`repos/${repo}/pulls?state=open&per_page=100`, {
      paginate: true,
      jq: `.[] | select(.head.ref == "${branch}") | {number, url: .html_url, body} | tojson`,
    }),
  );
  if (!pr) {
    console.log(`No open PR for ${branch}; no Slack reply sent.`);
    return;
  }

  const issues = [...mentionedIssues(pr.body ?? '')].map((number) => ({
    number,
    comments: jsonLines<string>(
      (() => {
        try {
          return ghApi(`repos/${repo}/issues/${number}/comments`, {
            paginate: true,
            jq: '.[] | .body | tojson',
          });
        } catch {
          // A number in the PR body that is not an issue, or a comment fetch that failed.
          return '';
        }
      })(),
    ),
  }));
  const thread = newestThread(issues);
  if (!thread) {
    console.log('No issue in the PR has a Slack thread; no Slack reply sent.');
    return;
  }

  const text = buildReply({
    kind: (argValue('--kind') ?? 'opened') as ReplyInput['kind'],
    prNumber: pr.number,
    prUrl: pr.url,
    outcome: argValue('--outcome'),
    statusUrl: argValue('--status-url'),
  });
  const result = await postSlackMessage(token, {
    channel: thread.channel,
    threadTs: thread.ts,
    text,
  });
  console.log(
    result.ok
      ? `Replied in the Slack thread of issue #${thread.issue}.`
      : `::warning::Slack reply failed: ${result.error ?? 'unknown error'}`,
  );
}

main().catch((error: unknown) => {
  console.log(
    `::warning::Slack reply failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});

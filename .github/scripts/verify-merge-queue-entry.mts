import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { verifyMergeQueueRetry } from './shared/merge-queue-entry.mts';

const REPO = process.env.REPO ?? '';
const PR_NUMBER = process.env.PR_NUMBER ?? '';
const HEAD_SHA = process.env.HEAD_SHA ?? '';
const HEAD_BRANCH = process.env.HEAD_BRANCH ?? '';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT ?? '';

if (!REPO || !PR_NUMBER || !HEAD_SHA || !HEAD_BRANCH) {
  throw new Error('REPO, PR_NUMBER, HEAD_SHA, and HEAD_BRANCH must be set');
}

const [owner, repository] = REPO.split('/');
if (!owner || !repository) {
  throw new Error(`Invalid repository: ${REPO}`);
}

const query = `query($owner: String!, $repository: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repository) {
    pullRequest(number: $prNumber) {
      mergeQueueEntry {
        headCommit {
          oid
        }
      }
    }
  }
}`;

const verification = await verifyMergeQueueRetry({
  expectedHeadSha: HEAD_SHA,
  getHeadSha: async () => {
    const response = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          'graphql',
          '-f',
          `query=${query}`,
          '-F',
          `owner=${owner}`,
          '-F',
          `repository=${repository}`,
          '-F',
          `prNumber=${PR_NUMBER}`,
        ],
        { encoding: 'utf8' },
      ),
    ) as {
      data?: {
        repository?: {
          pullRequest?: {
            mergeQueueEntry?: { headCommit?: { oid?: string } };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (response.errors?.length) {
      throw new Error(response.errors.map(({ message }) => message).join('; '));
    }

    return (
      response.data?.repository?.pullRequest?.mergeQueueEntry?.headCommit?.oid ??
      null
    );
  },
  refExists: async () => {
    try {
      execFileSync('gh', ['api', `repos/${REPO}/git/ref/heads/${HEAD_BRANCH}`], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  },
});

console.log(`Merge queue entry verification: ${verification.state}`);
if (GITHUB_OUTPUT) {
  appendFileSync(GITHUB_OUTPUT, `state=${verification.state}\n`);
}

if (verification.state !== 'current') {
  const description =
    verification.state === 'stale'
      ? 'Merge queue entry was replaced — skipping retry'
      : 'Could not verify merge queue entry — skipping retry';
  console.warn(description);
  execFileSync(
    'gh',
    [
      'api',
      `repos/${REPO}/statuses/${HEAD_SHA}`,
      '--method',
      'POST',
      '-f',
      'state=failure',
      '-f',
      'context=All jobs pass',
      '-f',
      `description=${description}`,
    ],
    { stdio: 'inherit' },
  );
}

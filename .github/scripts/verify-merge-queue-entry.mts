import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { verifyMergeQueueEntry } from './shared/merge-queue-entry.mts';

const REPO = process.env.REPO ?? '';
const PR_NUMBER = process.env.PR_NUMBER ?? '';
const HEAD_SHA = process.env.HEAD_SHA ?? '';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT ?? '';

if (!REPO || !PR_NUMBER || !HEAD_SHA) {
  throw new Error('REPO, PR_NUMBER, and HEAD_SHA must be set');
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

const verification = await verifyMergeQueueEntry({
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
});

console.log(`Merge queue entry verification: ${verification.state}`);
if (GITHUB_OUTPUT) {
  appendFileSync(GITHUB_OUTPUT, `state=${verification.state}\n`);
}

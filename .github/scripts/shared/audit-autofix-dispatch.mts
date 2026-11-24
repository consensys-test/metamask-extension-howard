// Starts the audit autofix workflow for a freshly created "Yarn Audit" tracking issue.
import { ghApi } from './gh-api.mts';

export const AUTOFIX_WORKFLOW = 'audit-autofix.yml';

export type DispatchRequest = {
  path: string;
  body: { ref: string; inputs: { issues: string; 'dry-run': string } };
};

export function buildDispatchRequest(
  repo: string,
  ref: string,
  issueNumber: number,
): DispatchRequest {
  return {
    path: `/repos/${repo}/actions/workflows/${AUTOFIX_WORKFLOW}/dispatches`,
    body: {
      ref,
      inputs: { issues: String(issueNumber), 'dry-run': 'false' },
    },
  };
}

/**
 * The switch is the repository variable AUDIT_AUTOFIX_ENABLED, passed in as an env var, so
 * merging the workflows changes nothing until someone turns it on.
 */
export function autofixEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env.AUDIT_AUTOFIX_ENABLED === 'true';
}

/** A dispatch with GITHUB_TOKEN does start a run; only other events are suppressed for it. */
export function dispatchAutofix(
  repo: string,
  ref: string,
  issueNumber: number,
  token: string,
): void {
  const { path, body } = buildDispatchRequest(repo, ref, issueNumber);
  ghApi(path, { method: 'POST', body }, token);
}

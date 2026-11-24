// Starts the audit autofix workflow for the open "Yarn Audit" tracking issues.
import { ghApi } from './gh-api.mts';

export const AUTOFIX_WORKFLOW = 'audit-autofix.yml';

export type DispatchRequest = {
  path: string;
  body: { ref: string; inputs: { issues: string; 'dry-run': string } };
};

// `open` rather than one issue: GitHub keeps one pending run per concurrency group and drops
// an older pending one, so the run that survives must cover every open issue.

export function buildDispatchRequest(
  repo: string,
  ref: string,
): DispatchRequest {
  return {
    path: `/repos/${repo}/actions/workflows/${AUTOFIX_WORKFLOW}/dispatches`,
    body: {
      ref,
      inputs: { issues: 'open', 'dry-run': 'false' },
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
  token: string,
): void {
  const { path, body } = buildDispatchRequest(repo, ref);
  ghApi(path, { method: 'POST', body }, token);
}

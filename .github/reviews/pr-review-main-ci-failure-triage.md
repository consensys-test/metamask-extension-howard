# PR Review: `main-test-howard` vs `main`

## Summary

This PR introduces a **"Main CI Failure Triage" system** that replaces the inline `check-retry-ci` job in `main.yml` with a dedicated `workflow_run`-triggered workflow (`main-ci-failure-triage.yml`). When the Main workflow fails, the triage workflow classifies each failed job as retryable or non-retryable using configurable patterns (`retry-config.jsonc`), writes a markdown report to the step summary, optionally creates a GitHub Check Run and logs to Sentry. Retry remains label-gated (`retry-ci`) and now works for both `pull_request` and `merge_group` events. For merge queue, it defers the "All jobs pass" check creation so there's a retry window before the queue ejects the PR.

**However, the branch contains extensive test scaffolding** — injected `exit 1` failures, commented-out conditions, deleted unrelated workflows, and a disabled schedule trigger — that must not be merged. The core design (classify + defer check + label-gated retry) is sound, but the branch needs significant cleanup before it's merge-ready.

## Files Changed

| File | Description |
|------|-------------|
| `.github/workflows/main.yml` | Renamed `all-jobs-pass` → `all-jobs-pass-initiator`, added Checks API step, removed inline `check-retry-ci` job, added `checks: write` permission. **Also contains test scaffolding: injected `exit 1`s, commented-out conditions, disabled schedule.** |
| `.github/workflows/main-ci-failure-triage.yml` | **New.** `workflow_run` workflow that classifies failures, label-gates retry, and creates deferred check for merge queue. |
| `.github/scripts/classify-failures.mts` | **New.** TypeScript script that classifies failed jobs by pattern matching + transient-error detection, writes report, creates Check Run, logs to Sentry. |
| `.github/scripts/github-token.mts` | **New.** Helper to resolve GitHub token from env vars or `gh auth token`. |
| `.github/rules/retry-config.jsonc` | **New.** JSONC config for job classification patterns, transient error patterns, and blocker definitions. |
| `.github/workflows/get-requirements.yml` | **Test scaffolding:** injected `exit 1`, force `skip-everything=true`, commented-out condition. |
| `.github/workflows/build-ts-migration-dashboard.yml` | **Test scaffolding:** injected `exit 1` with "502 Bad Gateway". |
| `.github/workflows/main-retry.yml` | **Deleted.** No longer needed (retry is handled by triage workflow). |
| 6 other workflows | **Deleted for testing:** `check-feature-flag-registry.yml`, `check-pr-labels.yml`, `check-pr-max-lines.yml`, `check-template-and-add-labels.yml`, `cla.yml`, `security-code-scanner.yml` |

## Issues Found

### 🔴 Critical

**1. Injected `exit 1` in `prep-deps` job (main.yml)**

The `prep-deps` job has a bare `- run: exit 1` as its first step. This will fail the dependency preparation step and cascade-fail almost every downstream job. Must be removed before merge.

**2. Injected `exit 1` in `build-lavamoat-viz` job (main.yml)**

Same issue — bare `exit 1` will fail the LavaMoat viz build unconditionally.

**3. Injected `exit 1` in `get-requirements` (get-requirements.yml)**

`echo "502 Bad Gateway"; exit 1` — this will fail the requirements job, breaking all downstream conditionals. The "502 Bad Gateway" string appears to be testing transient error detection.

**4. Injected `exit 1` in `build-ts-migration-dashboard` (build-ts-migration-dashboard.yml)**

Same pattern — `echo "502 Bad Gateway"; exit 1` for testing transient error classification.

**5. Forced `skip-everything=true` in `get-requirements` (get-requirements.yml)**

The `if:` condition on the "Compute skip-everything flag" step is commented out, so `skip-everything=true` is *always* emitted. This skips almost every job in the workflow regardless of what changed.

**6. Commented-out `if` conditions on `build-ts-migration-dashboard` and `build-lavamoat-viz` (main.yml)**

These conditions prevent the jobs from running in merge_group or when skip-everything is true. With them commented out, the jobs always run (and then hit the injected `exit 1`).

**7. Commented-out `exit 1` for BUILDS_FROM_RUN validation (main.yml)**

The guard check that prevents merging when builds came from a different run is disabled. This would allow merging with stale build artifacts.

**8. Six unrelated workflows deleted**

`check-feature-flag-registry.yml`, `check-pr-labels.yml`, `check-pr-max-lines.yml`, `check-template-and-add-labels.yml`, `cla.yml`, `security-code-scanner.yml` — these appear to be production workflows for feature flag validation, PR label checking, CLA enforcement, and security scanning. Deleting them would remove important CI guardrails. If they were intentionally disabled for testing, they must be restored.

**9. Schedule trigger commented out (main.yml)**

The overnight CI schedule is disabled. If intentional, it belongs in a separate change with rationale. The commit message "no more auto-retry" doesn't explain disabling overnight runs.

### 🟡 Warning

**10. `PR_NUMBER` may be empty for non-PR `workflow_run` events (main-ci-failure-triage.yml)**

```yaml
PR_NUMBER: ${{ github.event.workflow_run.pull_requests[0].number }}
```

For `merge_group` and `push` events, `pull_requests` is often an empty array, making `pull_requests[0].number` evaluate to `''`. This is handled downstream by the "Resolve PR number" step (which falls through to regex extraction for merge_group), but the env var name `PR_NUMBER` being empty is misleading. Not a bug, but could confuse future maintainers.

**11. Race condition: merge queue may evaluate before triage creates the check**

For merge_group failures, `main.yml` skips check creation, deferring to the triage workflow. But `workflow_run` is asynchronous — there's a gap between main.yml completion and the triage workflow running. During this gap, the merge queue might evaluate and see **no** "All jobs pass" check. The comment says _"Do not require status checks on creation" must be enabled_, which means missing checks don't fail. But this creates a window where the merge queue could *pass* a failing PR if it evaluates during this gap and no prior "All jobs pass" check exists for that SHA.

**12. `getFailedJobs` doesn't handle pagination (classify-failures.mts)**

```typescript
const jobsPath = ... `per_page=100`;
```

If a workflow has >100 jobs, some failed jobs could be missed. The Main workflow currently has ~35+ jobs, and with matrix expansions (e2e), this could approach the limit. Should either paginate or document the assumption.

**13. `npm install --no-save @sentry/node` installs unpinned version (main-ci-failure-triage.yml)**

This installs whatever the latest `@sentry/node` is at runtime. A breaking change in Sentry's API (e.g., `Sentry.logger.info` is currently a preview feature) could break the script. Consider pinning: `npm install --no-save @sentry/node@8`.

**14. `Sentry.logger.info()` relies on preview Sentry Logs feature (classify-failures.mts)**

`enableLogs: true` and `Sentry.logger.info()` are part of Sentry's "Structured Logs" feature, which was in preview. If the installed `@sentry/node` version doesn't support `Sentry.logger`, this will throw. The Sentry block is wrapped in try/catch, so it won't crash the workflow, but the data would be silently lost.

**15. `CHECK_RUN_TOKEN` secret is a fork workaround that should be tracked for removal**

The TODO comments are clear, but there's no tracking issue referenced. Once merged to the real repo, this workaround might linger indefinitely.

### 🔵 Suggestion

**16. Rewrite the main.yml check condition for readability**

Truth table is correct:
- Success + any event → runs ✓
- Failure + merge_group → **skipped** (delegated to triage) ✓
- Failure + non-merge_group → runs ✓

But `!failure() || github.event_name != 'merge_group'` reads unnaturally. Consider rewriting:
```yaml
if: ${{ !(failure() && github.event_name == 'merge_group') }}
```
This is logically equivalent (De Morgan's law) and reads as "skip only when failing in merge_group."

**17. `stripJsonComments` is fragile (classify-failures.mts)**

The regex-based comment stripping won't handle `//` inside string values. Fine for the current config, but consider using a proper JSONC parser or documenting the limitation.

**18. Consider adding `--filter=failed` to the jobs API call**

Instead of fetching all 100 jobs and filtering client-side, reducing payload size.

**19. The "optional" category in retry-config includes `^All jobs pass`**

This matches the renamed `All jobs pass (initiator)` job. Since the triage workflow runs on the *previous* run, the "All jobs pass (initiator)" job would show as failed in the jobs list. Marking it optional means its failure doesn't influence the retry decision, which is correct. But the comment should explain this — it's not intuitive that the gateway job is "optional."

**20. Consider `retryableOnTransientError` as default instead of `alwaysRetryable`**

`defaults.unmatchedCategory: "alwaysRetryable"` means any new job added to main.yml that isn't in the config will be always retried. This could mask real failures in new deterministic jobs. `retryableOnTransientError` is a safer default.

### ℹ️ Note

**21. Reusable workflow job names include the caller prefix**

For jobs using `workflow_call`, the GitHub API returns job names as `caller-job-id / callee-job-name`. The retry config patterns like `^validate-lavamoat-policies` correctly match the prefix. Verified this works.

**22. Top-level `await` in `.mts` file**

`await Sentry.flush(5000)` at the top level. Node.js v24 supports top-level await in ESM (`.mts` is ESM), so this works.

**23. `tagCascade` function marks cascaded jobs with the blocker's retryability**

When a retryable blocker fails, all downstream jobs are also marked retryable with reason "Cascade — will resolve when blocker retries." This is sensible: if the blocker is retried and succeeds, the cascaded jobs will run in the retry.

## Questions for Author

1. **Are all the test scaffolding changes (injected `exit 1`s, commented-out conditions) intended to be cleaned up before merge?** The commit messages suggest iterative testing.

2. **Why were the six unrelated workflows deleted?** Are they being moved elsewhere, or was this for testing convenience?

3. **Is disabling the overnight schedule intentional for production?**

4. **For the merge queue race condition (#11): Has "Do not require status checks on creation" been enabled on the branch protection rules?**

5. **Is there a plan to pin the `@sentry/node` version?** The `Sentry.logger.info()` API is a preview feature.

6. **Should `defaults.unmatchedCategory` be `retryableOnTransientError` instead of `alwaysRetryable`?**

7. **Does the `BUILDS_FROM_RUN` guard need to be re-enabled?**

## Overall Assessment

**🔴 Request Changes**

The architectural design — a dedicated triage workflow with configurable classification, Sentry logging, and deferred check creation for merge queue retry — is well-thought-out and a significant improvement over the inline `check-retry-ci` approach. The `classify-failures.mts` script is well-structured with good separation of concerns, CLI+CI dual usage, and graceful fallbacks.

However, **the branch is not merge-ready due to extensive test scaffolding mixed in with production changes**. There are at least 9 critical items (injected failures, commented-out guards, deleted unrelated workflows) that would break CI for every PR if merged. These need to be removed and the branch rebased/cleaned before review of the actual production changes can proceed.

Recommended next steps:
1. Remove all injected `exit 1` statements and restore commented-out conditions
2. Restore the six deleted unrelated workflows (or split their removal into a separate PR with justification)
3. Re-enable the schedule trigger and `BUILDS_FROM_RUN` guard (or justify their removal)
4. Pin `@sentry/node` version
5. Consider the `unmatchedCategory` default and the race condition for merge queue

You are repairing one failing CI check on a draft pull request that fixes Yarn audit advisories in the MetaMask Browser Extension. A human reviews and merges the result. Work from evidence only: every claim in your report must come from a command you ran.

## Input

- `.tmp/audit-autofix/repair/failure.json`: the classified failure from the planner (`kinds`, `signature`, the failing job names and steps) and how many repairs were already pushed.
- `.tmp/audit-autofix/repair/failure.log`: about 50 lines of the failing log around the error. The cause can sit above the cleanup lines at the end of a job log.
- `.tmp/audit-autofix/repair/rows.md`: the branch diff grouped by advisory row, with the packages each row changed in `package.json` and `yarn.lock`, and the rows an earlier repair already redid.
- The checkout is the tip of the PR branch with `node_modules` installed. You have `yarn`, `node`, `git`, `jq`, `grep`. You have no GitHub token.

## What you may change

Only the rows named in `rows.md`: `package.json`, `yarn.lock`, `.yarn/patches/**`. Never touch a row that did not cause the failure. Do not add a new fix, delete or skip a check, edit `.yarnrc.yml`, or raise a memory limit or timeout to make a check pass. Never commit or push.

## Steps

1. Attribute the failure to one row. Compare what the failing check exercises with the packages each row changed: a lint or type failure points at the row that moved the toolchain (`typescript-eslint`, `eslint`, `webpack`, `babel`, `jest`, `storybook`), a heap out of memory in lint at a version bump of the TypeScript ESLint stack, a test failure at the package the test imports. If no row explains the failure, write `needs-human` as the result, say what you checked, and stop without changing files.
2. Redo that row with a smaller change, in this order:
   - A scoped resolution that keeps the toolchain at its old version and moves only the vulnerable child for that parent, for example `@typescript-eslint/typescript-estree@npm:8.62.0/minimatch@npm:^10.2.2`. Prefer a version `yarn.lock` already holds, and the ranged key form so it stops matching when the parent moves on.
   - A parent change on the same major that does not move a toolchain family.
   - Otherwise move the row to category C with the reason and revert it.
3. Restore the row's old `package.json` and `yarn.lock` lines first (`git checkout <base> -- package.json yarn.lock`, then re-apply the other rows' entries from `rows.md`), then apply the smaller change, `yarn install --mode=update-lockfile`, `yarn dedupe --check`, and run the churn guard as in the main prompt.
4. Prove it by re-running the failing check itself on the final tree. Do not stand in the generic smoke test for it:
   - `lint` and `lint-heap`: `yarn lint:eslint` (the repo script, with its own heap limit, about 6 to 9 minutes). A heap failure is fixed only when it completes without the memory error.
   - `depcheck`: `yarn depcheck`.
   - `unit-test`: the failing test file, with `yarn test:unit <file>`.
   - Anything else: the command from the failing step in `failure.json`.
   Run it once on the final tree. If it still fails, revert the row's change, report the row under C and stop.
5. Re-audit: `yarn npm audit --recursive --json` must still show the row's advisory fixed. A repair that brings the advisory back is not a repair.

## Report

Write `.tmp/audit-autofix/repair-report.md`: the failing check, the row you blamed and the evidence (the command and what it showed), what you changed (old and new versions), the proof command and its result, and any row you moved to C. No issue-closing keywords (`Closes`, `Fixes`, `Resolves`).

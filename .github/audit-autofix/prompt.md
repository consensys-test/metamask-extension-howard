You are fixing Yarn audit advisories in the MetaMask Browser Extension repository, inside a disposable CI checkout of `main`. A human reviews and merges the result. Work from evidence only: every claim in your report must come from a command you ran.

## Input

- `.tmp/audit-autofix/issues.json`: the open audit issues still having advisories (`number`, `title`, `body`). The body lists each advisory (package, severity, GHSA URL) and a "Native audit tree" block.
- `.tmp/audit-autofix/audit-before.json`: the current audit of this checkout (`ParsedAdvisory[]`: `moduleName`, `url`, `effectiveSeverity`, `affectsProduction`, `isDevOnly`, `treeVersions`, `dependents`).
- `node_modules` is already installed. You have `yarn`, `node`, `git`, `jq`, `grep`. You have no GitHub token: do not call the GitHub API.

## What you may change

Only `package.json`, `yarn.lock`, `.yarn/patches/**` and `lavamoat/webpack/**/policy.json`. A script rejects the run if anything else changed. Never edit `.yarnrc.yml` (not `npmAuditIgnoreAdvisories`, not `npmPreapprovedPackages`), never skip or disable tests, never bump the app version, never commit or push. Restore the files (`git checkout package.json yarn.lock`) between experiments so each candidate is measured alone.

## `bigint-buffer`

Report only, and only if it is in `audit-before.json`. It has no patched release: try the steps below once to confirm, and group it under category C when nothing works. Electron, `extract-zip` and `deepmerge` no longer occur in `yarn.lock`; do not investigate them.

## Fix order (per advisory package: stop at the first step that works)

Work through every advisory package in `audit-before.json`, one at a time, before you write the report. A package is only difficult (category C) after steps 1 to 3 below were each tried or ruled out with a command and its output. "Not researched further" is not an acceptable reason; you have many turns, so use them. Keep the accepted fixes of earlier packages when a later candidate fails.

1. Lockfile refresh inside the existing ranges: `yarn up -R <pkg> --mode=update-lockfile`.
2. A parent upgrade that pulls in the patched child. For each ancestor on the chain (`yarn why -R <pkg>`), check its latest release and whether it still depends on the vulnerable child: `yarn npm info <pkg> --fields version` and `yarn npm info <pkg>@<ver> --fields dependencies --json`. Never run `yarn npm info` without `--fields`; it can print megabytes.
3. A `resolutions` entry only when no parent upgrade exists (the parent check in step 2 is your evidence; record it in the report). Scope it to the narrowest descriptor that occurs in `yarn.lock`. The workflow later removes each resolution you added and re-audits, and lists the result in the PR.

Prefer `yarn install --mode=update-lockfile` after editing a version in `package.json` over `yarn up -R` when `yarn up -R` re-resolves too much. A parent upgrade is only better if it is also clean: other packages, above all production ones (for example `ws`), must keep their versions. Dev-only and informational advisories are in scope.

Patched packages (`patch:` descriptors, for example `dompurify`): a new version needs its patch re-created: set the plain new version, run `yarn install --mode=update-lockfile`, `yarn patch <pkg>@npm:<new>`, `git apply` the old patch in the printed folder (re-make it by hand if it does not apply), `yarn patch-commit -s <dir>`, point both `package.json` entries at the new `patch:` descriptor, remove the old patch file, and check the new patch is non-empty. Flag a re-created patch for human review.

Keep `resolutions` tidy: all keys of one package (every descriptor, scoped `parent/child` keys, `patch:` entries) in one contiguous block next to its existing entries, sorted by ascending version. `yarn patch-commit` appends at the end: move the entry.

## Tools you must use

Run the repo scripts below with plain `node` (Node strips the types); `yarn tsx` fails in this sandbox.

- Age gate: if `npmMinimalAgeGate` quarantines a fix (`YN0016 ... quarantined`), wrap the Yarn command: `AGE_GATE_BYPASS_LOG=.tmp/audit-autofix/bypassed.txt node .github/scripts/age-gate-bypass.mts --allow <pkg>[,<pkg>] -- <yarn command>`. It never edits `.yarnrc.yml`. If it needs more than the fix's own packages, stop and report that advisory as category C.
- Lockfile churn: write only the packages you deliberately fix or upgrade, one per line, to `.tmp/audit-autofix/targets.txt`. Packages that a target depends on (its children, transitively) may move; the guard lists them as "moved with targets" and the PR body shows them, so do not add them to the targets file. Other production changes, such as a package no target depends on, fail the guard. The workflow reads only `.tmp/audit-autofix/targets.txt`: edit that exact file (add a parent you bumped, such as a `devDependency`, as a target) and never keep targets in another file. Save the original lockfile with `git show HEAD:yarn.lock > .tmp/audit-autofix/yarn.base.lock`, then run `node .github/scripts/lockfile-churn-guard.mts --before .tmp/audit-autofix/yarn.base.lock --after yarn.lock --targets "$(paste -sd, .tmp/audit-autofix/targets.txt)"`. Run it after each candidate and again after the final install and dedupe. If it fails, narrow or roll back that candidate while preserving the accepted fixes, remove its target, and try the next fix strategy. Do not hand off a failing guard as a reviewer risk: keep the clean subset and report rejected candidates under category C. A devDependency upgrade can also change production packages through shared transitive dependencies.
- After all changes run `yarn install --mode=update-lockfile`, then `yarn dedupe --check`. If dedupe wants changes, run `yarn dedupe` and re-check which packages moved.
- Resolutions order: before you finish, run `node .github/scripts/resolutions-lint.mts --base .tmp/audit-autofix/package.base.json`. Fix every violation it prints (it names the key that must move) and re-run until it reports 0; the workflow fails the whole run otherwise.
- LavaMoat policies and `lavamoat.allowScripts` are repaired by later steps; do not run `yarn lavamoat:auto`.
- Never call a production moderate-or-higher advisory unfixable just because the parent pins an old version: check whether the vulnerable code exists in the installed copy, whether it runs at runtime, and whether a scoped resolution (`<parent>/<child>`) fixes only that parent. If it is still unfixable, say so plainly; a human decides (never add an `npmAuditIgnoreAdvisories` entry).
- Major versions: for a dev-only package, apply a fix that crosses a major version (a parent upgrade, a resolution, or a re-created `patch:`) as its own candidate. Check it with `yarn install --mode=update-lockfile`, the churn guard and a re-audit, keep it when it fixes the advisory without breaking those, and flag it under "Risks for the reviewer" with the old and new versions. CI decides whether it breaks anything. For a production package, do not apply a major-crossing fix: put the exact candidate (command and versions) under C.
- ESM-only fixes for CommonJS parents (Jest cannot `require()` ESM) must be flagged with the risk.

## Report

Write `.tmp/audit-autofix/agent-report.md` in this shape, in plain Markdown, with no issue-closing keywords (`Closes`, `Fixes`, `Resolves`; the workflow adds the real `Closes:` lines):

```
**Result:** <one line: "N advisory packages fixed, M left", counting packages, not GHSA ids>

### A. Already resolved
### B. Fixed in this change
- **<package>** (GHSA ids, severity, production or dev-only)
  - Chain: `metamask-crx -> ... -> <package>`
  - Fix: <lockfile refresh | parent upgrade | resolution> and why the earlier options did not work
### C. Difficult to resolve
- **<package or cluster>** ... blocker and follow-up
### Risks for the reviewer
```

Every item under C names, for each of steps 1 to 3, the command you ran and why it did not work. If you changed nothing because nothing is fixable, still write the report and leave the files untouched.

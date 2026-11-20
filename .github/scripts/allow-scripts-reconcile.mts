// Compares the `lavamoat.allowScripts` block that `yarn allow-scripts auto`
// produced with the one on the base branch, and keeps only changes that belong
// to packages the fix changed in yarn.lock. Exits 1 when auto changed anything
// else; `--out` receives the reconciled block as JSON either way.
//
// Usage: yarn tsx .github/scripts/allow-scripts-reconcile.mts --base <package.json> --auto <package.json> --before <yarn.lock> --after <yarn.lock> [--out <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { computeChurn, parseLockfile } from './shared/lockfile-churn.mts';
import {
  reconcileAllowScripts,
  type AllowScripts,
  type AllowScriptsChange,
} from './shared/allow-scripts-reconcile.mts';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argValue(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const readAllowScripts = (file: string): AllowScripts =>
  (
    JSON.parse(readFileSync(file, 'utf8')) as {
      lavamoat?: { allowScripts?: AllowScripts };
    }
  ).lavamoat?.allowScripts ?? {};

const describe = ({ key, before, after }: AllowScriptsChange) =>
  `- ${key}: ${before ?? '(absent)'} -> ${after ?? '(absent)'}`;

function main(): void {
  const changedPackages = new Set(
    computeChurn({
      before: parseLockfile(readFileSync(required('--before'), 'utf8')),
      after: parseLockfile(readFileSync(required('--after'), 'utf8')),
      targets: new Set(),
      rootDependencies: {},
    }).map(({ name }) => name),
  );

  const { reconciled, related, unrelated } = reconcileAllowScripts({
    base: readAllowScripts(required('--base')),
    auto: readAllowScripts(required('--auto')),
    changedPackages,
  });

  console.log(`${related.length} related allowScripts changes.`);
  console.log(related.map(describe).join('\n'));

  const out = argValue('--out');
  if (out) {
    writeFileSync(out, `${JSON.stringify(reconciled, null, 2)}\n`);
  }

  if (unrelated.length > 0) {
    console.error(
      `\nallow-scripts auto changed entries unrelated to the fix:\n${unrelated.map(describe).join('\n')}`,
    );
    process.exitCode = 1;
  }
}

main();

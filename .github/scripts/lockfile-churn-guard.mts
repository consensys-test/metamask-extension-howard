// Fails when a fix changed packages it did not target and that ship in the extension.
//
// Production packages that a targeted package depends on may move; they are listed
// (with major jumps and extra versions marked) for the PR body via --out.
//
// Usage: node .github/scripts/lockfile-churn-guard.mts --before <yarn.lock> --after <yarn.lock> --targets a,b [--package-json <file>] [--out <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { argValue } from './shared/cli.mts';
import {
  computeChurn,
  movedWithTargets,
  parseLockfile,
  riskyChanges,
  type PackageChange,
} from './shared/lockfile-churn.mts';

function required(name: string): string {
  const value = argValue(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const describe = ({
  name,
  before,
  after,
  targeted,
  production,
  majorJump,
  extraVersion,
}: PackageChange) =>
  `- ${name}: ${before.join(', ') || '(none)'} -> ${after.join(', ') || '(none)'}` +
  `${targeted ? ' [targeted]' : ''}${production ? ' [production]' : ''}` +
  `${majorJump ? ' [major jump]' : ''}${extraVersion ? ' [extra version]' : ''}`;

function main(): void {
  const packageJson = JSON.parse(
    readFileSync(argValue('--package-json') ?? 'package.json', 'utf8'),
  ) as { dependencies?: Record<string, string> };

  const changes = computeChurn({
    before: parseLockfile(readFileSync(required('--before'), 'utf8')),
    after: parseLockfile(readFileSync(required('--after'), 'utf8')),
    targets: new Set(required('--targets').split(',').filter(Boolean)),
    rootDependencies: packageJson.dependencies ?? {},
  });
  const risky = riskyChanges(changes);
  const moved = movedWithTargets(changes);

  console.log(
    `${changes.length} packages changed, ${risky.length} untargeted in production.`,
  );
  console.log(changes.map(describe).join('\n'));

  const outFile = argValue('--out');
  if (outFile) {
    writeFileSync(outFile, moved.map(describe).join('\n'));
  }

  if (risky.length > 0) {
    console.error(
      `\nUntargeted production changes:\n${risky.map(describe).join('\n')}`,
    );
    process.exitCode = 1;
  }
}

main();

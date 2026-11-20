// Applies the LavaMoat policy patches CI produced (artifacts `lavamoat-policy-diff-*`,
// downloaded into --dir) and checks each file ends up byte-identical to CI's result.
// Local `yarn lavamoat:auto` is unreliable, so CI's own diff is the source of truth.
//
// Usage: yarn tsx .github/scripts/lavamoat-apply-ci-diff.mts --dir <patch-dir>
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hashMismatches,
  parsePatchFiles,
  unexpectedPaths,
} from './shared/lavamoat-patch.mts';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();

function main(): void {
  const dir = argValue('--dir');
  if (!dir) {
    throw new Error('Missing --dir');
  }

  const patches = readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort();
  if (patches.length === 0) {
    console.log('No policy patches to apply.');
    return;
  }

  const failures: string[] = [];
  for (const name of patches) {
    const file = join(dir, name);
    const files = parsePatchFiles(readFileSync(file, 'utf8'));

    const unexpected = unexpectedPaths(files);
    if (unexpected.length > 0) {
      failures.push(
        `${name} touches non-policy files: ${unexpected.join(', ')}`,
      );
      continue;
    }

    git('apply', file);
    const bad = hashMismatches(files, (path) => git('hash-object', path));
    if (bad.length > 0) {
      failures.push(
        `${name}: hash differs from CI for ${bad.map(({ path }) => path).join(', ')}`,
      );
    }
    console.log(`${name}: applied ${files.length} files.`);
  }

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

main();

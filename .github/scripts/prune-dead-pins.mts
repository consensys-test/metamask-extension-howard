// Removes `resolutions` that no dependency can match any more, and `.yarn/patches` files that
// nothing references. A pin only counts as dead when removing every dead pin at once leaves
// `yarn.lock` byte for byte unchanged; otherwise nothing is removed and the report says so.
//
// Usage: yarn tsx .github/scripts/prune-dead-pins.mts [--out <file>]
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { argValue } from './shared/cli.mts';
import { updateLockfile, writePackageJson } from './shared/yarn-cli.mts';
import { deadPins, unreferencedPatches } from './shared/dead-pins.mts';
import { parseLockfile } from './shared/lockfile-churn.mts';

const PATCH_DIR = '.yarn/patches';
type PackageJson = Record<string, unknown> & {
  name: string;
  resolutions?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function main(): void {
  const originalText = readFileSync('package.json', 'utf8');
  const originalLock = readFileSync('yarn.lock', 'utf8');
  const pkg = JSON.parse(originalText) as PackageJson;
  const resolutions = pkg.resolutions ?? {};
  const lines: string[] = [];

  const dead = deadPins({
    resolutions,
    entries: parseLockfile(originalLock),
    rootName: pkg.name,
    rootDependencies: { ...pkg.devDependencies, ...pkg.dependencies },
  });

  let pinsRemoved = false;
  if (dead.length > 0) {
    writePackageJson({
      ...pkg,
      resolutions: Object.fromEntries(
        Object.entries(resolutions).filter(([key]) => !dead.includes(key)),
      ),
    });
    updateLockfile();
    if (readFileSync('yarn.lock', 'utf8') === originalLock) {
      pinsRemoved = true;
      lines.push(
        ...dead.map(
          (key) => `- Removed dead pin \`${key}\` -> \`${resolutions[key]}\`.`,
        ),
      );
    } else {
      writeFileSync('package.json', originalText);
      writeFileSync('yarn.lock', originalLock);
      lines.push(
        `- Found ${dead.length} dead pin(s) (${dead.map((key) => `\`${key}\``).join(', ')}) but kept them: removing them changed \`yarn.lock\`.`,
      );
    }
  }

  // The pins above may have been the last references to a patch.
  if (existsSync(PATCH_DIR)) {
    const unused = unreferencedPatches(readdirSync(PATCH_DIR), [
      readFileSync('package.json', 'utf8'),
      readFileSync('yarn.lock', 'utf8'),
    ]);
    for (const file of unused) {
      rmSync(`${PATCH_DIR}/${file}`);
      lines.push(`- Deleted unreferenced patch \`${PATCH_DIR}/${file}\`.`);
    }
  }

  const out = argValue('--out');
  if (out) {
    writeFileSync(out, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }
  console.log(
    lines.length > 0 ? lines.join('\n') : 'No dead pins or unused patches.',
  );
  console.log(`pinsRemoved=${pinsRemoved}`);
}

main();

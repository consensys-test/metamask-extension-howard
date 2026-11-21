// Fails when the `resolutions` of package.json break the one-sorted-block-per-package rule.
//
// Usage: yarn tsx .github/scripts/resolutions-lint.mts [--base <package.json>] [--head <package.json>]
//   With --base, only packages the branch touched are checked; without it, every package is.
//   With --fix, the touched packages are sorted into place in --head first.
import { readFileSync, writeFileSync } from 'node:fs';
import { argValue } from './shared/cli.mts';
import {
  lintResolutions,
  sortResolutions,
} from './shared/resolutions-lint.mts';

type PackageJson = Record<string, unknown> & {
  resolutions?: Record<string, unknown>;
};

const readPackage = (path: string): PackageJson =>
  JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

function main(): void {
  const basePath = argValue('--base');
  const headPath = argValue('--head') ?? 'package.json';
  const base = basePath ? (readPackage(basePath).resolutions ?? {}) : undefined;
  const headPackage = readPackage(headPath);

  if (process.argv.includes('--fix')) {
    headPackage.resolutions = sortResolutions({
      base,
      head: headPackage.resolutions ?? {},
    });
    writeFileSync(headPath, `${JSON.stringify(headPackage, null, 2)}\n`);
  }

  const violations = lintResolutions({
    base,
    head: headPackage.resolutions ?? {},
  });

  for (const { packageName, kind, detail } of violations) {
    console.error(`${packageName}: ${kind} (${detail})`);
  }
  console.log(`${violations.length} resolution block violations.`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}

main();

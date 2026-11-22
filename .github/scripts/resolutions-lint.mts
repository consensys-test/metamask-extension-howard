// Fails when the `resolutions` of package.json break the one-sorted-block-per-package rule.
//
// Usage: yarn tsx .github/scripts/resolutions-lint.mts [--base <package.json>] [--head <package.json>]
//   With --base, only packages the branch touched are checked; without it, every package is.
import { readFileSync } from 'node:fs';
import { lintResolutions } from './shared/resolutions-lint.mts';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const readResolutions = (path: string): Record<string, unknown> =>
  (
    JSON.parse(readFileSync(path, 'utf8')) as {
      resolutions?: Record<string, unknown>;
    }
  ).resolutions ?? {};

function main(): void {
  const basePath = argValue('--base');
  const violations = lintResolutions({
    base: basePath ? readResolutions(basePath) : undefined,
    head: readResolutions(argValue('--head') ?? 'package.json'),
  });

  for (const { packageName, kind, detail } of violations) {
    console.error(`${packageName}: ${kind} (${detail})`);
  }
  console.log(`${violations.length} resolution block violations.`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}

main();

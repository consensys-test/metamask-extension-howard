// Fails when a dependency change breaks the lint or dependency tooling at startup, the way
// `minimatch` remaps once broke ESLint and depcheck. It does not lint anything: `eslint
// --print-config` loads the config and every plugin in about 3 s, where linting even one file
// takes about a minute. Rule findings, types and tests are left to CI.
//
// Usage: yarn tsx .github/scripts/tooling-smoke.mts   (needs an installed node_modules)
import { execFileSync } from 'node:child_process';
import { yarn } from './shared/yarn-cli.mts';
import { pickSmokeFile } from './shared/tooling-smoke.mts';

function run(name: string, args: string[]): boolean {
  const started = Date.now();
  try {
    yarn(args);
    console.log(
      `ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
    return true;
  } catch (error) {
    const { stdout = '', stderr = '' } = error as {
      stdout?: string;
      stderr?: string;
    };
    console.log(`FAIL ${name}`);
    console.log(
      `${stdout}${stderr}`.trim().split('\n').slice(0, 30).join('\n'),
    );
    return false;
  }
}

const tracked = execFileSync('git', ['ls-files', 'shared', 'ui'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

// One file per parser setup (.ts and .tsx) so every override and plugin loads.
const eslintFiles = [
  pickSmokeFile(tracked, '.ts'),
  pickSmokeFile(tracked, '.tsx'),
];
if (eslintFiles.some((file) => file === undefined)) {
  throw new Error('No .ts or .tsx file found to point ESLint at.');
}

const results = [
  ...(eslintFiles as string[]).map((file) =>
    run(`eslint --print-config ${file}`, [
      'eslint',
      '-c',
      './.eslintrc.js',
      '--print-config',
      file,
    ]),
  ),
  run('depcheck', ['depcheck']),
];

process.exit(results.every(Boolean) ? 0 : 1);

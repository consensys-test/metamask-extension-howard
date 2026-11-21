// Runs a Yarn command and, when `npmMinimalAgeGate` quarantines packages the fix needs,
// preapproves them through YARN_NPM_PREAPPROVED_PACKAGES and retries. `.yarnrc.yml` is
// never edited, so no preapproval can be left behind. Prints the bypassed packages for
// the PR body.
//
// `--preapprove a,b` approves those packages from the first run. Use it for an in-range
// refresh such as `yarn up -R`, where Yarn silently keeps the older version instead of
// reporting a quarantine.
//
// Usage: yarn tsx .github/scripts/age-gate-bypass.mts [--allow a,b] [--preapprove a,b] [--max-rounds 5] -- <command> [args...]
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { argValue } from './shared/cli.mts';
import { parsePreapproved, runWithBypass } from './shared/age-gate.mts';

const MAX_ROUNDS_DEFAULT = 5;

const list = (flag: string): string[] | undefined =>
  argValue(flag)?.split(',').filter(Boolean);

const separator = process.argv.indexOf('--');
const [command, ...args] =
  separator === -1 ? [] : process.argv.slice(separator + 1);
if (!command) {
  throw new Error('Missing command after --');
}

const outcome = runWithBypass({
  run: (preapproved) => {
    const env = { ...process.env };
    if (preapproved !== undefined) {
      env.YARN_NPM_PREAPPROVED_PACKAGES = preapproved;
    }
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result;
  },
  existing: parsePreapproved(readFileSync('.yarnrc.yml', 'utf8')),
  allowed: list('--allow'),
  preapprove: list('--preapprove'),
  maxRounds: Number(argValue('--max-rounds') ?? MAX_ROUNDS_DEFAULT),
  info: (message) => console.log(message),
  warn: (message) => console.error(message),
});

if (
  outcome.succeeded &&
  outcome.bypassed.length > 0 &&
  process.env.AGE_GATE_BYPASS_LOG
) {
  appendFileSync(
    process.env.AGE_GATE_BYPASS_LOG,
    `${outcome.bypassed.join('\n')}\n`,
  );
}
process.exitCode = outcome.exitCode;

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
import {
  buildPreapprovedEnv,
  parsePreapproved,
  parseQuarantined,
} from './shared/age-gate.mts';

const MAX_ROUNDS_DEFAULT = 5;

function main(): void {
  const separator = process.argv.indexOf('--');
  const [command, ...args] =
    separator === -1 ? [] : process.argv.slice(separator + 1);
  if (!command) {
    throw new Error('Missing command after --');
  }

  const allowed = argValue('--allow')?.split(',').filter(Boolean);
  const maxRounds = Number(argValue('--max-rounds') ?? MAX_ROUNDS_DEFAULT);
  const existing = parsePreapproved(readFileSync('.yarnrc.yml', 'utf8'));
  const bypassed: string[] =
    argValue('--preapprove')?.split(',').filter(Boolean) ?? [];

  for (let round = 0; round <= maxRounds; round++) {
    const env = { ...process.env };
    if (bypassed.length > 0) {
      env.YARN_NPM_PREAPPROVED_PACKAGES = buildPreapprovedEnv(
        existing,
        bypassed,
      );
    }

    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);

    const quarantined = parseQuarantined(`${result.stdout}\n${result.stderr}`);
    if (result.status === 0 || quarantined.length === 0) {
      if (bypassed.length > 0) {
        console.log(`\nAge gate bypassed for: ${bypassed.join(', ')}`);
        if (result.status === 0 && process.env.AGE_GATE_BYPASS_LOG) {
          appendFileSync(
            process.env.AGE_GATE_BYPASS_LOG,
            `${bypassed.join('\n')}\n`,
          );
        }
      }
      process.exitCode = result.status ?? 1;
      return;
    }

    const refused = allowed
      ? quarantined.filter((name) => !allowed.includes(name))
      : [];
    if (refused.length > 0) {
      console.error(
        `\nQuarantined but not allowed to bypass: ${refused.join(', ')}`,
      );
      process.exitCode = 2;
      return;
    }

    const added = quarantined.filter((name) => !bypassed.includes(name));
    if (added.length === 0) {
      console.error('\nStill quarantined after preapproval; stopping.');
      process.exitCode = 1;
      return;
    }
    bypassed.push(...added);
    console.log(`\nRetrying with age gate bypassed for: ${added.join(', ')}`);
  }

  console.error(`\nStill quarantined after ${maxRounds} rounds.`);
  process.exitCode = 1;
}

main();

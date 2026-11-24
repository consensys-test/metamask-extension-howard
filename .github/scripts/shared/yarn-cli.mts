import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Set AUDIT_AUTOFIX_YARN_COMMAND="corepack yarn" where plain `yarn` is not on PATH.
const [YARN, ...YARN_ARGS] = (
  process.env.AUDIT_AUTOFIX_YARN_COMMAND ?? 'yarn'
).split(' ');

/** Runs Yarn and returns stdout; with `tolerateFailure`, a non-zero exit returns what it printed. */
export function yarn(args: string[], tolerateFailure = false): string {
  try {
    return execFileSync(YARN, [...YARN_ARGS, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // `yarn npm audit` exits non-zero whenever it finds advisories.
    if (!tolerateFailure) {
      throw error;
    }
    return (error as { stdout?: string }).stdout ?? '';
  }
}

/** Re-resolves `yarn.lock` for the current `package.json` without touching node_modules. */
export function updateLockfile(): void {
  const output = yarn(['install', '--mode=update-lockfile'], true);
  // Without node_modules the install still exits 1 after the lockfile update (postinstall).
  if (/YN0(001|016|027|035)/u.test(output) || !output.includes('Link step')) {
    throw new Error(`Lockfile update failed:\n${output}`);
  }
}

export function writePackageJson(pkg: unknown): void {
  writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Package names Yarn reported as quarantined by `npmMinimalAgeGate` (YN0016), in first-seen order. */
export function parseQuarantined(output: string): string[] {
  const names = new Set<string>();
  for (const match of output.matchAll(
    /YN0016:\s*│?\s*(@?[^@\s]+(?:\/[^@\s]+)?)@npm:\S+: All versions satisfying/gu,
  )) {
    names.add(match[1]);
  }
  return [...names];
}

/** Entries of the `npmPreapprovedPackages` list in a `.yarnrc.yml` (a plain block list). */
export function parsePreapproved(yarnrc: string): string[] {
  const lines = yarnrc.split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    line.startsWith('npmPreapprovedPackages:'),
  );
  if (start === -1) {
    return [];
  }

  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(?:'([^']*)'|"([^"]*)"|([^\s#]+))/u.exec(line);
    if (item) {
      entries.push(item[1] ?? item[2] ?? item[3]);
    } else if (!/^\s*(#.*)?$/u.test(line)) {
      break;
    }
  }
  return entries;
}

/**
 * Value for `YARN_NPM_PREAPPROVED_PACKAGES`. The variable replaces the
 * `.yarnrc.yml` list instead of extending it, so the existing entries are
 * repeated. Yarn reads it as a comma-separated list.
 */
export function buildPreapprovedEnv(
  existing: string[],
  extra: string[],
): string {
  return [...new Set([...existing, ...extra])].join(',');
}

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type BypassOptions = {
  /** Runs the command once; `preapproved` is the `YARN_NPM_PREAPPROVED_PACKAGES` value, or undefined for none. */
  run: (preapproved: string | undefined) => CommandResult;
  existing: string[];
  /** Packages allowed to be bypassed; any other quarantined package stops the run. */
  allowed?: string[];
  /** Packages approved from the first run. */
  preapprove?: string[];
  maxRounds: number;
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type BypassOutcome = {
  exitCode: number;
  bypassed: string[];
  /** True when the command succeeded, so `bypassed` really was needed. */
  succeeded: boolean;
};

/**
 * Runs a command and, while Yarn reports quarantined packages, preapproves
 * them and retries. Exit codes: the command's own, 1 when quarantine persists,
 * 2 when a quarantined package is not in `allowed`.
 */
export function runWithBypass({
  run,
  existing,
  allowed,
  preapprove = [],
  maxRounds,
  info,
  warn,
}: BypassOptions): BypassOutcome {
  const bypassed = [...preapprove];

  for (let round = 0; round <= maxRounds; round++) {
    const result = run(
      bypassed.length > 0 ? buildPreapprovedEnv(existing, bypassed) : undefined,
    );
    const quarantined = parseQuarantined(`${result.stdout}\n${result.stderr}`);

    if (result.status === 0 || quarantined.length === 0) {
      if (bypassed.length > 0) {
        info(`\nAge gate bypassed for: ${bypassed.join(', ')}`);
      }
      return {
        exitCode: result.status ?? 1,
        bypassed,
        succeeded: result.status === 0,
      };
    }

    const refused = allowed
      ? quarantined.filter((name) => !allowed.includes(name))
      : [];
    if (refused.length > 0) {
      warn(`\nQuarantined but not allowed to bypass: ${refused.join(', ')}`);
      return { exitCode: 2, bypassed, succeeded: false };
    }

    const added = quarantined.filter((name) => !bypassed.includes(name));
    if (added.length === 0) {
      warn('\nStill quarantined after preapproval; stopping.');
      return { exitCode: 1, bypassed, succeeded: false };
    }
    bypassed.push(...added);
    info(`\nRetrying with age gate bypassed for: ${added.join(', ')}`);
  }

  warn(`\nStill quarantined after ${maxRounds} rounds.`);
  return { exitCode: 1, bypassed, succeeded: false };
}

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

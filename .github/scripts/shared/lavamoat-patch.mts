export type PatchedFile = {
  path: string;
  /** Abbreviated blob hash of the file after the patch (the `index a..b` line). */
  newBlob: string;
  deleted: boolean;
};

const POLICY_PATH = /^lavamoat\/webpack\/.+\/policy\.json$/u;

/** Files a `git diff` patch touches, with the blob hash each should end up as. */
export function parsePatchFiles(patch: string): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: { path: string; deleted: boolean } | undefined;

  for (const line of patch.split(/\r?\n/u)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header) {
      current = { path: header[2], deleted: false };
      continue;
    }
    if (current && line.startsWith('deleted file mode')) {
      current.deleted = true;
    }
    const index = /^index [0-9a-f]+\.\.([0-9a-f]+)/u.exec(line);
    if (current && index) {
      files.push({ ...current, newBlob: index[1] });
      current = undefined;
    }
  }

  return files;
}

/** Paths outside the webpack policy files, which a policy patch must never touch. */
export function unexpectedPaths(files: PatchedFile[]): string[] {
  return files
    .map(({ path }) => path)
    .filter((path) => !POLICY_PATH.test(path));
}

/** Files whose blob hash after applying does not match the patch's `+` side. */
export function hashMismatches(
  files: PatchedFile[],
  hashOf: (path: string) => string,
): PatchedFile[] {
  return files.filter(
    ({ path, newBlob, deleted }) =>
      !deleted && !hashOf(path).startsWith(newBlob),
  );
}

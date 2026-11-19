/** First tracked source file with `extension` that ESLint would lint as real code (no tests, types or stories). */
export function pickSmokeFile(
  files: string[],
  extension: '.ts' | '.tsx',
): string | undefined {
  return files.find(
    (file) =>
      (file.startsWith('shared/') || file.startsWith('ui/')) &&
      file.endsWith(extension) &&
      !/\.(test|stories|d)\.tsx?$/u.test(file) &&
      !file.includes('__'),
  );
}

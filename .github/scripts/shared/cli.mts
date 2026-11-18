/** Value after `name` in the command line (`--out file`), or undefined when the flag is absent. */
export function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

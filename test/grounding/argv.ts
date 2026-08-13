/**
 * Parses `--only <value>` out of argv. Pulled into its own module (no side effects, no
 * top-level execution) so it can be unit tested without importing run.ts, which executes the
 * live, money-spending eval as a side effect of being imported.
 *
 * Returns:
 *  - `null` when `--only` is absent -- run every case.
 *  - the value when `--only <value>` is well-formed.
 *  - `undefined` when `--only` is present but malformed: no value follows it at all (it was the
 *    last argv entry), or the next token is itself a flag (e.g. `--only --judge`). Before this
 *    fix, `process.argv[i + 1]` being `undefined` made `only` falsy, which fell through to
 *    running the entire (billable) 30-case corpus silently -- exactly the failure mode this
 *    return value exists to make the caller handle explicitly instead.
 */
export function parseOnly(argv: string[]): string | null | undefined {
  const i = argv.indexOf('--only');
  if (i < 0) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

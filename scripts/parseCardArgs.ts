import type { Surface } from '../src/bundle/types.js';

export interface ParsedCardArgs {
  refText: string;
  surface: Surface;
}

// Extracted from scripts/card.ts so the --surface flag stripping can be unit-tested.
// Bug fixed here: when --surface is absent (surfaceIdx === -1), the original
// `args.filter((_, i) => i !== surfaceIdx && i !== surfaceIdx + 1)` still evaluated
// `i !== surfaceIdx + 1` as `i !== 0`, silently dropping args[0] — e.g. `npm run card -- QZ-252`
// would filter out "QZ-252" itself, leaving an empty refText. Guarding on surfaceIdx === -1
// keeps every arg when the flag isn't present.
export function parseCardArgs(args: string[]): ParsedCardArgs {
  const surfaceIdx = args.indexOf('--surface');
  const surface: Surface = surfaceIdx >= 0 ? (args[surfaceIdx + 1] as Surface) : 'dm';
  const refText = (
    surfaceIdx === -1 ? args : args.filter((_, i) => i !== surfaceIdx && i !== surfaceIdx + 1)
  ).join(' ');
  return { refText, surface };
}

import { SURFACES, type Surface } from '../src/bundle/types.js';

const DEFAULT_SURFACE: Surface = 'dm';

export interface ParsedCardArgs {
  refText: string;
  surface: Surface;
}

export type ParseCardArgsResult =
  | { ok: true; args: ParsedCardArgs }
  | { ok: false; error: string };

function isSurface(value: string | undefined): value is Surface {
  return (SURFACES as readonly string[]).includes(value ?? '');
}

// Extracted from scripts/card.ts so the --surface flag stripping can be unit-tested.
// Bug fixed here (kept): when --surface is absent (surfaceIdx === -1), the original
// `args.filter((_, i) => i !== surfaceIdx && i !== surfaceIdx + 1)` still evaluated
// `i !== surfaceIdx + 1` as `i !== 0`, silently dropping args[0] — e.g. `npm run card -- QZ-252`
// would filter out "QZ-252" itself, leaving an empty refText. Guarding on surfaceIdx === -1
// keeps every arg when the flag isn't present.
//
// Confidentiality bug fixed here: --surface used to be blind-cast to Surface, so a typo
// (`--surface multipary`) or a trailing `--surface` with no value produced a value that is
// not 'multiparty' -- which assemble.ts then treats as a surface that should NOT suppress
// internal Zendesk notes, the opposite of what the operator asked for. Any value outside
// SURFACES (including a missing one) is now a typed error instead of a silent bad default.
export function parseCardArgs(args: string[]): ParseCardArgsResult {
  const surfaceIdx = args.indexOf('--surface');
  if (surfaceIdx === -1) {
    return { ok: true, args: { refText: args.join(' '), surface: DEFAULT_SURFACE } };
  }
  const rawSurface = args[surfaceIdx + 1];
  if (!isSurface(rawSurface)) {
    return {
      ok: false,
      error: `--surface inválido (${rawSurface ?? 'ausente'}); use um de: ${SURFACES.join(', ')}`,
    };
  }
  const refText = args.filter((_, i) => i !== surfaceIdx && i !== surfaceIdx + 1).join(' ');
  return { ok: true, args: { refText, surface: rawSurface } };
}

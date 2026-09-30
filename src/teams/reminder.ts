import { normalizeText } from '@/text/normalize.js';
import type { CardBundle } from '@/bundle/types.js';

/** Normalized whole-message command (spec §3); display copy keeps the accent. */
export const LEMBRAR_COMMAND = 'lembrar responsavel';
export const NOTE_MAX_CHARS = 280;
export const NOTE_TOO_LONG =
  `A nota é longa demais (limite de ${NOTE_MAX_CHARS} caracteres). Encurte e tente novamente.`;
export const REMINDER_NEEDS_CARD =
  'Para lembrar o responsável, primeiro abra um card (ex.: `QZ-252`) e envie `lembrar responsável`.';
export const NO_ASSIGNEE_REPLY = 'Este card não tem responsável no Jira, então não há quem lembrar.';

// Derive regex from LEMBRAR_COMMAND so they cannot drift
const [LEMBRAR_VERB, LEMBRAR_TARGET] = LEMBRAR_COMMAND.split(' ');
const LEMBRAR_RE = new RegExp(`^${LEMBRAR_VERB} (?:o )?${LEMBRAR_TARGET}\\s*(?::(.*))?$`);

export function parseLembrar(text: string): { note?: string; tooLong?: true } | null {
  // Normalize the command shell but slice the note from the ORIGINAL text so casing/accents survive.
  const normalized = normalizeText(text).replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, '').trim();
  const m = LEMBRAR_RE.exec(normalized);
  if (!m) return null;
  if (m[1] === undefined) return {};
  const colon = text.indexOf(':');
  const note = colon >= 0 ? text.slice(colon + 1).trim() : '';
  if (note === '') return null;
  if (note.length > NOTE_MAX_CHARS) return { note: undefined, tooLong: true };
  return { note };
}

/** The bound card's responsible person, as Jira renders it (same read as `src/fetch/jira.ts`). */
export function bundleAssignee(bundle: CardBundle): string | undefined {
  const assignee = bundle.jira?.fields.assignee as { displayName?: string } | null | undefined;
  return assignee?.displayName || undefined;
}

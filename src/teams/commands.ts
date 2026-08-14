import { normalizeText } from '@/text/normalize.js';

/**
 * Temporary stand-ins for Adaptive Card affordances (addendum §8). When Phase 4 ships buttons,
 * these remain as aliases — typing is natural in a DM — but the buttons become primary.
 */
export const AJUDA_COMMAND = 'ajuda';
/** Named separately so the Refresh button's `verb` (src/teams/cards.ts) derives from this
 * instead of duplicating the literal — the two can never drift apart (Task 5 review finding). */
export const ATUALIZAR_COMMAND = 'atualizar';
export const VOLTAR_COMMAND = 'voltar';

export const COMMANDS = [AJUDA_COMMAND, ATUALIZAR_COMMAND, VOLTAR_COMMAND] as const;
export type Command = (typeof COMMANDS)[number];

/**
 * Matches only when the WHOLE message is the command. "preciso de ajuda com esse card" is a
 * question about the card, not a request for usage text.
 */
export function parseCommand(text: string): Command | null {
  const normalized = normalizeText(text).trim();
  return (COMMANDS as readonly string[]).includes(normalized) ? (normalized as Command) : null;
}

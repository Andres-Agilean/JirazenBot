import type { Surface } from '@/bundle/types.js';

/** The only conversation type Teams uses for a 1:1 chat with the bot. */
export const PERSONAL_CONVERSATION_TYPE = 'personal';

/**
 * Fails closed by construction: only an exact 'personal' yields `dm`. The SDK types this field
 * as `'personal' | 'groupChat' | Omit<string, ...>` -- an OPEN union -- so an unrecognised value
 * is reachable, and the costs are asymmetric. Fail closed and a DM loses internal Zendesk notes
 * it was entitled to: visible and annoying. Fail open and internal agent notes reach a channel:
 * silent, and not undoable (spec §2, addendum §3).
 */
export function surfaceFor(conversationType: string | undefined): Surface {
  return conversationType === PERSONAL_CONVERSATION_TYPE ? 'dm' : 'multiparty';
}

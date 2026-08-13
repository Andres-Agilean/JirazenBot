import type { Surface } from '@/bundle/types.js';

/**
 * Phase 3 is DM-only (plan §8, spec §2/§10): every bundle load in this phase happens with this
 * constant, never derived from the activity. That is deliberate but dangerous — a group chat or
 * channel exercised through the Playground today would still be answered as `dm`, including
 * internal Zendesk agent notes that the `multiparty` surface exists specifically to suppress
 * (spec §10, addendum §3/§8).
 *
 * Phase 4's first change must be to derive the surface from
 * `activity.conversation.conversationType` instead of importing this constant, and that change
 * must land before the bot is ever exercised in a multiparty scope. `test/surface.test.ts`
 * asserts this constant is `'dm'` as the tripwire spec §10/§11.8 calls for: editing that
 * assertion to allow something other than `'dm'` is the intended signal that the derivation has
 * landed, not a silent regression.
 */
export const SURFACE: Surface = 'dm';

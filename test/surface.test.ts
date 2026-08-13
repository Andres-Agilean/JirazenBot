import { describe, expect, it } from 'vitest';
import { SURFACE } from '@/teams/surface.js';

describe('the dm-surface tripwire (spec §10 / §11.8)', () => {
  it('is dm for every conversation in Phase 3', () => {
    // SURFACE is a constant fed to loadCardBundle for every conversation in this phase (see
    // scripts/serve.ts) -- there is no branch on the activity, so asserting the constant is
    // equivalent to asserting it for every conversation the bot handles.
    //
    // Phase 4 must change this to derive the surface from
    // `activity.conversation.conversationType` before the bot is ever exercised in a group chat
    // or channel; otherwise a multiparty conversation is answered as `dm`, leaking internal
    // Zendesk agent notes that the `multiparty` surface exists to suppress (spec §10).
    //
    // Editing this assertion to allow something other than 'dm' is the INTENDED signal that
    // Phase 4's derivation has landed -- not a regression to silence.
    expect(SURFACE).toBe('dm');
  });
});

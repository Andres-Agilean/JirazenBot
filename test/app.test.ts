import { describe, expect, it, vi } from 'vitest';
import { handleActivity, handleCardAction, UNEXPECTED_ERROR_REPLY, UNKNOWN_INVOKE_ACTION_REPLY } from '@/teams/app.js';
import { NO_TEXT_RECEIVED, SELECTION_INVALID, handleSelect, type HandleDeps } from '@/teams/handleMessage.js';
import { InMemoryBindingStore, type Binding, type BindingStore, type Slot } from '@/teams/bindings.js';
import { InMemoryCandidateStore } from '@/teams/candidates.js';
import { REFRESH_ACTION } from '@/teams/cards.js';
import { SELECT_ACTION } from '@/teams/rundown.js';
import { testConfig } from './helpers.js';

function makeDeps(over: Partial<HandleDeps> = {}): HandleDeps {
  return {
    store: new InMemoryBindingStore(),
    loadBundle: async () => {
      throw new Error('loadBundle should not be called in these tests');
    },
    answerFn: async () => {
      throw new Error('answerFn should not be called in these tests');
    },
    cfg: testConfig,
    now: () => 0,
    candidates: new InMemoryCandidateStore(() => 0),
    search: async () => {
      throw new Error('search should not be called in these tests');
    },
    ...over,
  };
}

/**
 * `makeDeps` overridden so a message resolves to a bound QZ-252 answer -- shared by every test
 * below that needs an actual reply to go out, rather than each repeating the same
 * loadBundle/answerFn stub.
 */
function cardDeps(over: Partial<HandleDeps> = {}): HandleDeps {
  return makeDeps({
    loadBundle: async () => ({
      status: 'ok',
      bundle: {
        fetchedAt: '2026-08-13T17:32:00.000Z',
        surface: 'dm',
        jira: { issueId: '1', issueKey: 'QZ-252', fields: {}, comments: [], statusHistory: [] },
        resolution: { via: 'direct_only', ambiguous: false },
        truncationNotes: [],
      },
    }),
    answerFn: async () => ({
      text: 'resposta',
      model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    ...over,
  });
}

/** A BindingStore whose every method rejects, for exercising the "unexpected failure" path. */
function throwingStore(): BindingStore {
  return {
    get: async (): Promise<Binding | undefined> => { throw new Error('store.get boom'); },
    set: async (_slot: Slot, _binding: Binding): Promise<void> => { throw new Error('store.set boom'); },
    delete: async (): Promise<void> => { throw new Error('store.delete boom'); },
  };
}

describe('handleActivity: never goes silent on text-less activities (spec §8)', () => {
  it('replies with NO_TEXT_RECEIVED instead of returning silently when activity.text is empty', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    await handleActivity(send, '', [], 'conv', 'personal', 'u', deps);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(NO_TEXT_RECEIVED);
  });

  it('replies with NO_TEXT_RECEIVED when activity.text is undefined (attachment-only message)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    await handleActivity(send, undefined, [], 'conv', 'personal', 'u', deps);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(NO_TEXT_RECEIVED);
  });

  it('replies with NO_TEXT_RECEIVED when the text is only whitespace', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    await handleActivity(send, '   \n\t  ', [], 'conv', 'personal', 'u', deps);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(NO_TEXT_RECEIVED);
  });
});

describe('handleActivity: a failing typing indicator never blocks the reply', () => {
  it('still answers when send({ type: "typing" }) rejects, as the Playground does (spec §2)', async () => {
    const send = vi.fn().mockImplementation(async (activity: unknown) => {
      if (typeof activity === 'object' && activity !== null && (activity as { type?: string }).type === 'typing') {
        throw new Error('a Playground-like channel rejects typing activities');
      }
      return undefined;
    });
    const deps = cardDeps();

    await handleActivity(send, 'QZ-252', [], 'conv', 'personal', 'u', deps);

    // The typing send was attempted and rejected, but a real reply still went out.
    const nonTypingCalls = send.mock.calls.filter(([activity]) => {
      return !(typeof activity === 'object' && activity !== null && (activity as { type?: string }).type === 'typing');
    });
    expect(nonTypingCalls).toHaveLength(1);
    // The answer goes out as a card attachment (spec §5), not a bare string and not on the
    // activity's `text` -- see the no-duplication test below for why `text` is deliberately
    // absent. Asserting the answer reached the user via the card body.
    expect(JSON.stringify(nonTypingCalls[0][0])).toContain('resposta');
  });

  it('does not throw out of handleActivity when the typing send rejects', async () => {
    const send = vi.fn().mockImplementation(async (activity: unknown) => {
      if (typeof activity === 'object' && activity !== null && (activity as { type?: string }).type === 'typing') {
        throw new Error('typing rejected');
      }
      return undefined;
    });
    const deps = makeDeps();

    await expect(handleActivity(send, 'bom dia', [], 'conv', 'personal', 'u', deps)).resolves.toBeUndefined();
  });
});

describe('handleActivity: cards (spec §5)', () => {
  it('sends a card as an adaptive-card attachment carrying the answer', async () => {
    const sent: unknown[] = [];
    const deps = cardDeps();
    await handleActivity(
      async (a) => { sent.push(a); return undefined; },
      'QZ-252', [], 'c', 'personal', 'u', deps,
    );
    const activity = sent.find(
      (a): a is { attachments: { contentType: string; content: unknown }[]; text?: string } =>
        typeof a === 'object' && a !== null && 'attachments' in a,
    );
    expect(activity).toBeDefined();
    expect(activity?.attachments[0].contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
    expect(JSON.stringify(activity?.attachments[0].content)).toContain('coletado às');
  });

  // Teams renders an activity's `text` AND its `attachments`, so putting the answer in both made
  // the user read it twice -- reproduced in the M365 Agents Playground, which uses the same
  // rendering engine. This pins the fix: the card activity carries no `text` at all.
  it('does not duplicate the answer on the activity text alongside the card', async () => {
    const sent: unknown[] = [];
    const deps = cardDeps();
    await handleActivity(
      async (a) => { sent.push(a); return undefined; },
      'QZ-252', [], 'c', 'personal', 'u', deps,
    );
    const activity = sent.find(
      (a): a is { attachments: unknown[]; text?: string } =>
        typeof a === 'object' && a !== null && 'attachments' in a,
    );
    expect(activity?.text).toBeUndefined();
  });

  // `fallbackText` is still load-bearing after the change above: it is what a client that rejects
  // the attachment receives, which is the real coverage for a non-card-rendering client.
  it('resends the answer as plain text when the card attachment is rejected', async () => {
    const sent: unknown[] = [];
    const send = async (a: unknown) => {
      if (typeof a === 'object' && a !== null && 'attachments' in a) throw new Error('card rejected');
      // The typing indicator goes through the same send; it is not a reply.
      if (typeof a === 'object' && a !== null && (a as { type?: string }).type === 'typing') {
        return undefined;
      }
      sent.push(a);
      return undefined;
    };
    await handleActivity(send, 'QZ-252', [], 'c', 'personal', 'u', cardDeps());
    expect(sent).toHaveLength(1);
    expect(String(sent[0])).toContain('coletado às');
  });
});

describe('handleCardAction: never goes silent on an unexpected failure (spec §6/§8)', () => {
  it('sends UNEXPECTED_ERROR_REPLY instead of nothing when the underlying store rejects', async () => {
    const sent: unknown[] = [];
    const deps = makeDeps({ store: throwingStore() });

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      REFRESH_ACTION, undefined, 'c', 'personal', 'u', deps,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(UNEXPECTED_ERROR_REPLY);
  });
});

describe('handleCardAction: routes on the invoke verb (spec §7, review finding: Minor 5)', () => {
  it('runs the Refresh path when the verb is the known Refresh verb', async () => {
    const sent: unknown[] = [];
    // A clock consistent with cardDeps's `now: () => 0` -- InMemoryBindingStore's own default
    // clock is Date.now(), which would read a binding bound at boundAt=0 as 24h-expired instantly.
    const store = new InMemoryBindingStore(() => 0);
    const deps = cardDeps({ store });
    // Bind first so handleRefresh has something to refresh.
    await handleActivity(async () => undefined, 'QZ-252', [], 'c', 'personal', 'u', deps);

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      REFRESH_ACTION, undefined, 'c', 'personal', 'u', deps,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe(UNKNOWN_INVOKE_ACTION_REPLY);
  });

  it('replies in pt-BR naming what it understood, instead of silently running Refresh, for an unrecognised verb', async () => {
    const sent: unknown[] = [];
    const deps = makeDeps();

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      'algumaOutraAcao', undefined, 'c', 'personal', 'u', deps,
    );

    expect(sent).toEqual([UNKNOWN_INVOKE_ACTION_REPLY]);
  });

  it('replies in pt-BR when the verb is missing entirely, instead of silently running Refresh', async () => {
    const sent: unknown[] = [];
    const deps = makeDeps();

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      undefined, undefined, 'c', 'personal', 'u', deps,
    );

    expect(sent).toEqual([UNKNOWN_INVOKE_ACTION_REPLY]);
  });

  it('routes SELECT_ACTION with valid data to handleSelect, flowing to a bind attempt', async () => {
    const sent: unknown[] = [];
    const store = new InMemoryBindingStore(() => 0);
    const loadBundleCalls: unknown[] = [];
    const deps = cardDeps({
      store,
      loadBundle: async (ref) => {
        loadBundleCalls.push(ref);
        return {
          status: 'ok',
          bundle: {
            fetchedAt: '2026-08-13T17:32:00.000Z',
            surface: 'dm',
            jira: { issueId: '1', issueKey: 'AGL-900', fields: {}, comments: [], statusHistory: [] },
            resolution: { via: 'direct_only', ambiguous: false },
            truncationNotes: [],
          },
        };
      },
    });

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      SELECT_ACTION,
      { system: 'jira', id: 'AGL-900' },
      'c', 'personal', 'u', deps,
    );

    // handleSelect should have called loadBundle with the explicit ref
    expect(loadBundleCalls).toHaveLength(1);
    expect(loadBundleCalls[0]).toEqual({
      system: 'jira',
      issueKey: 'AGL-900',
      explicit: true,
    });
    // Should send a reply (either text or card)
    expect(sent.length).toBeGreaterThan(0);
  });

  it('replies with SELECTION_INVALID when SELECT_ACTION has garbage payload', async () => {
    const sent: unknown[] = [];
    const deps = makeDeps();

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      SELECT_ACTION,
      { system: 'invalid', id: '' },
      'c', 'personal', 'u', deps,
    );

    expect(sent).toEqual([SELECTION_INVALID]);
  });

  it('never goes silent when handleSelect throws unexpectedly', async () => {
    const sent: unknown[] = [];
    const deps = makeDeps({ store: throwingStore() });

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      SELECT_ACTION,
      { system: 'jira', id: 'AGL-900' },
      'c', 'personal', 'u', deps,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(UNEXPECTED_ERROR_REPLY);
  });

  it('names both known actions in UNKNOWN_INVOKE_ACTION_REPLY for updated wording', async () => {
    const sent: unknown[] = [];
    const deps = makeDeps();

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      'unknownVerb', undefined, 'c', 'personal', 'u', deps,
    );

    expect(sent).toHaveLength(1);
    expect(String(sent[0])).toContain('Atualizar');
    expect(String(sent[0])).toContain('seleção de card');
  });
});

describe('sendReplies (via handleActivity): a failed card send retries once as plain text (spec §7, review finding: Minor 7)', () => {
  it('still delivers the answer text when Teams rejects the card attachment', async () => {
    const sent: unknown[] = [];
    const deps = cardDeps();
    const send = vi.fn().mockImplementation(async (activity: unknown) => {
      const isCard = typeof activity === 'object' && activity !== null && 'attachments' in activity;
      if (isCard) throw new Error('Teams rejected the attachment');
      sent.push(activity);
      return undefined;
    });

    await handleActivity(send, 'QZ-252', [], 'conv', 'personal', 'u', deps);

    // Exactly one non-typing send survives (the plain-text retry) and it carries the answer.
    const nonTyping = sent.filter((a) => !(typeof a === 'object' && a !== null && (a as { type?: string }).type === 'typing'));
    expect(nonTyping).toHaveLength(1);
    expect(nonTyping[0]).toContain('resposta');
  });

  it('propagates the failure when even the plain-text retry throws (no infinite retry, no silent swallow)', async () => {
    const deps = cardDeps();
    const send = vi.fn().mockRejectedValue(new Error('everything rejected'));

    // Both the card attempt and the plain-text retry throw; nothing in this file adds a SECOND
    // retry, so the rejection must propagate rather than being silently swallowed here.
    await expect(
      handleActivity(send, 'QZ-252', [], 'conv', 'personal', 'u', deps),
    ).rejects.toThrow('everything rejected');
  });
});

describe('handleActivity: per-conversation serialization (review findings: Important 1 & 2)', () => {
  it('does not let two overlapping messages for the same conversation race on the shared history', async () => {
    // A clock consistent with cardDeps's `now: () => 0` -- see the comment on the same line above.
    const store = new InMemoryBindingStore(() => 0);
    let releaseFirst: (() => void) | undefined;
    // Resolved the instant answerFn('first') is actually invoked -- a fixed number of
    // `await Promise.resolve()` ticks is not a reliable way to know `releaseFirst` has been
    // assigned (it depends on how many microtask hops resolveSlots/store.get take internally),
    // and calling `releaseFirst?.()` while it is still undefined would deadlock the test forever.
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const deps = cardDeps({
      store,
      answerFn: async (_b, question) => {
        if (question === 'first') {
          firstStarted();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { text: `resposta:${question}`, model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    });

    // Bind first so both calls below are follow-up QUESTIONS against the same shared binding --
    // exactly the read-modify-write race the fix closes (both would otherwise read the same
    // `history` at entry and the later write would clobber the earlier one).
    await handleActivity(async () => undefined, 'QZ-252', [], 'thread', 'channel', 'ana', deps);

    const p1 = handleActivity(async () => undefined, 'first', [], 'thread', 'channel', 'ana', deps);
    const p2 = handleActivity(async () => undefined, 'second', [], 'thread', 'channel', 'bruno', deps);

    // Deterministically wait until p1's answerFn has actually started (and so `releaseFirst` is
    // assigned) before releasing it -- see the comment above on why a fixed tick count is not
    // sufficient. Without serialization, p2's answerFn would already have completed by now
    // because it does not block on anything.
    await firstStartedPromise;

    releaseFirst?.();
    await p1;
    await p2;

    const shared = await store.get({ scope: 'shared', conversationId: 'thread' });
    const texts = (shared?.history ?? []).filter((t) => t.role === 'user').map((t) => t.text);
    // Both exchanges survive -- neither store.set() overwrote the other.
    expect(texts).toContain('first');
    expect(texts).toContain('second');
  });

  it('does not block a second, unrelated conversation while the first is still answering', async () => {
    let releaseSlow: (() => void) | undefined;
    const slowDeps = cardDeps({
      loadBundle: async (ref, surface) => {
        if (ref.system === 'jira' && ref.issueKey === 'AGL-1') {
          await new Promise<void>((resolve) => { releaseSlow = resolve; });
        }
        return {
          status: 'ok',
          bundle: {
            fetchedAt: '2026-08-13T17:32:00.000Z',
            surface,
            jira: { issueId: '1', issueKey: ref.system === 'jira' ? ref.issueKey : 'QZ-252', fields: {}, comments: [], statusHistory: [] },
            resolution: { via: 'direct_only', ambiguous: false },
            truncationNotes: [],
          },
        };
      },
    });

    // Ignores the typing-indicator send, which fires immediately for both conversations
    // regardless of the loadBundle delay and would otherwise pollute the ordering below.
    const isTyping = (a: unknown) => typeof a === 'object' && a !== null && (a as { type?: string }).type === 'typing';

    const order: string[] = [];
    const p1 = handleActivity(
      async (a) => { if (!isTyping(a)) order.push('slow-conv-sent'); return undefined; },
      'AGL-1', [], 'conv-slow', 'personal', 'u', slowDeps,
    );
    const p2 = handleActivity(
      async (a) => { if (!isTyping(a)) order.push('fast-conv-sent'); return undefined; },
      'QZ-252', [], 'conv-fast', 'personal', 'u', slowDeps,
    );

    await p2;
    // The fast, unrelated conversation completed while the slow one is still blocked.
    expect(order).toEqual(['fast-conv-sent']);

    releaseSlow?.();
    await p1;
    expect(order).toEqual(['fast-conv-sent', 'slow-conv-sent']);
  });
});

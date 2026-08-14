import { describe, expect, it, vi } from 'vitest';
import { handleActivity, handleCardAction, UNEXPECTED_ERROR_REPLY } from '@/teams/app.js';
import { NO_TEXT_RECEIVED, type HandleDeps } from '@/teams/handleMessage.js';
import { InMemoryBindingStore, type Binding, type BindingStore, type Slot } from '@/teams/bindings.js';
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
    // The answer now goes out as a card attachment (spec §5), not a bare string. Asserting on
    // the activity's `text` field specifically (its plain-text fallback) rather than on the
    // whole serialized activity: the card's body TextBlock also contains "resposta", so a
    // JSON.stringify-based check would still pass even if `text` were dropped entirely --
    // exactly the failure mode (empty text for non-card-rendering clients and mobile notification
    // previews) this assertion exists to catch.
    expect((nonTypingCalls[0][0] as { text?: string }).text).toContain('resposta');
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
  it('sends a card as an adaptive-card attachment, with the fallback text on the activity', async () => {
    const sent: unknown[] = [];
    const deps = cardDeps();
    await handleActivity(
      async (a) => { sent.push(a); return undefined; },
      'QZ-252', [], 'c', 'personal', 'u', deps,
    );
    const activity = sent.find(
      (a): a is { attachments: { contentType: string }[]; text: string } =>
        typeof a === 'object' && a !== null && 'attachments' in a,
    );
    expect(activity).toBeDefined();
    expect(activity?.attachments[0].contentType).toBe(
      'application/vnd.microsoft.card.adaptive',
    );
    expect(activity?.text).toContain('coletado às');
  });
});

describe('handleCardAction: never goes silent on an unexpected failure (spec §6/§8)', () => {
  it('sends UNEXPECTED_ERROR_REPLY instead of nothing when the underlying store rejects', async () => {
    const sent: unknown[] = [];
    const deps = makeDeps({ store: throwingStore() });

    await handleCardAction(
      async (a) => { sent.push(a); return undefined; },
      'c', 'personal', 'u', deps,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(UNEXPECTED_ERROR_REPLY);
  });
});

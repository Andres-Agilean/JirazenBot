import { describe, expect, it, vi } from 'vitest';
import { handleActivity } from '@/teams/app.js';
import { NO_TEXT_RECEIVED, type HandleDeps } from '@/teams/handleMessage.js';
import { InMemoryBindingStore } from '@/teams/bindings.js';
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

describe('handleActivity: never goes silent on text-less activities (spec §8)', () => {
  it('replies with NO_TEXT_RECEIVED instead of returning silently when activity.text is empty', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    await handleActivity(send, '', 'conv', deps);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(NO_TEXT_RECEIVED);
  });

  it('replies with NO_TEXT_RECEIVED when activity.text is undefined (attachment-only message)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    await handleActivity(send, undefined, 'conv', deps);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(NO_TEXT_RECEIVED);
  });

  it('replies with NO_TEXT_RECEIVED when the text is only whitespace', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    await handleActivity(send, '   \n\t  ', 'conv', deps);

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
    const deps = makeDeps({
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
    });

    await handleActivity(send, 'QZ-252', 'conv', deps);

    // The typing send was attempted and rejected, but a real reply still went out.
    const nonTypingCalls = send.mock.calls.filter(([activity]) => {
      return !(typeof activity === 'object' && activity !== null && (activity as { type?: string }).type === 'typing');
    });
    expect(nonTypingCalls).toHaveLength(1);
    expect(nonTypingCalls[0][0]).toContain('resposta');
  });

  it('does not throw out of handleActivity when the typing send rejects', async () => {
    const send = vi.fn().mockImplementation(async (activity: unknown) => {
      if (typeof activity === 'object' && activity !== null && (activity as { type?: string }).type === 'typing') {
        throw new Error('typing rejected');
      }
      return undefined;
    });
    const deps = makeDeps();

    await expect(handleActivity(send, 'bom dia', 'conv', deps)).resolves.toBeUndefined();
  });
});

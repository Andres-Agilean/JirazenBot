import { describe, expect, it } from 'vitest';
import {
  handleMessage, handleRefresh, JIRA_UNAVAILABLE, NOT_SPLIT, NO_THREAD_TO_REJOIN, NOTHING_BOUND,
  type HandleDeps, type Incoming,
} from '@/teams/handleMessage.js';
import { InMemoryBindingStore, BUNDLE_TTL_MS } from '@/teams/bindings.js';
import { PERSONAL_MARKER } from '@/teams/cards.js';
import type { Reply } from '@/teams/reply.js';
import { testConfig } from './helpers.js';
import type { CardBundle } from '@/bundle/types.js';
import type { AssembleResult } from '@/bundle/assemble.js';

const T0 = 1_000_000;
const CONV = 'conv';

/** Builds an `Incoming` for a personal 1:1 chat -- the shape almost every test below exercises. */
function dm(text: string, conversationId: string = CONV): Incoming {
  return { text, conversationId, conversationType: 'personal', userId: 'u' };
}

/** Reads the human-facing string out of a `Reply` regardless of kind, so Phase 3 assertions on
 * plain strings keep working even though `handleMessage` now returns cards for answers. */
function textOf(reply: Reply): string {
  return reply.kind === 'card' ? reply.fallbackText : reply.text;
}

/** ana and bruno share one channel thread throughout the shared/personal-split tests below. */
const ana = { conversationId: 'thread', conversationType: 'channel', userId: 'ana' };
const bruno = { conversationId: 'thread', conversationType: 'channel', userId: 'bruno' };

function bundleFor(issueKey: string, ticketId?: string): CardBundle {
  return {
    fetchedAt: '2026-08-13T17:32:00.000Z',
    surface: 'dm',
    jira: { issueId: '1', issueKey, fields: {}, comments: [], statusHistory: [] },
    ...(ticketId
      ? {
          zendesk: {
            ticketId, subject: 's', status: 'open', priority: null,
            createdAt: '', updatedAt: '', comments: [], internalNotesOmitted: false,
          },
        }
      : {}),
    resolution: { via: 'jira_zendesk_id_field', ambiguous: false },
    truncationNotes: [],
  } as CardBundle;
}

function makeDeps(over: Partial<HandleDeps> = {}) {
  const answered: string[] = [];
  const loaded: unknown[] = [];
  let now = T0;
  const deps: HandleDeps = {
    store: new InMemoryBindingStore(() => now),
    loadBundle: async (ref, _surface) => {
      loaded.push(ref);
      const key = ref.system === 'jira' ? ref.issueKey : 'QZ-252';
      return { status: 'ok', bundle: bundleFor(key, '16467') } as AssembleResult;
    },
    answerFn: async (_b, question) => {
      answered.push(question);
      return { text: `resposta para: ${question}`, model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    },
    cfg: testConfig,
    now: () => now,
    ...over,
  };
  return { deps, answered, loaded, setNow: (t: number) => { now = t; } };
}

describe('binding a card', () => {
  it('binds on a bare reference and answers the default summary question', async () => {
    const { deps, answered } = makeDeps();
    const replies = await handleMessage(dm('QZ-252'), deps);
    expect(answered).toHaveLength(1);
    expect(textOf(replies[0])).toContain('resposta para:');
    expect(textOf(replies[0])).toContain('QZ-252');
    expect(textOf(replies[0])).toContain('coletado às');
  });

  it('binds and answers the question when both are in one message', async () => {
    const { deps, answered } = makeDeps();
    await handleMessage(dm('QZ-252 quem validou?'), deps);
    expect(answered).toEqual(['quem validou?']);
  });

  it('answers follow-ups against the bound card without re-fetching', async () => {
    const { deps, answered, loaded } = makeDeps();
    await handleMessage(dm('QZ-252'), deps);
    await handleMessage(dm('quem validou?'), deps);
    await handleMessage(dm('e quando?'), deps);
    expect(loaded).toHaveLength(1); // bundle assembled once, reused
    expect(answered.slice(1)).toEqual(['quem validou?', 'e quando?']);
  });

  it('accumulates history across follow-ups', async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps({
      answerFn: async (_b, _q, history) => {
        seen.push([...history]);
        return { text: 'r', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    });
    await handleMessage(dm('QZ-252'), deps);
    await handleMessage(dm('quem validou?'), deps);
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([
      { role: 'user', text: expect.any(String) },
      { role: 'assistant', text: 'r' },
    ]);
  });

  it('switches cards on an explicit new reference and resets history', async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps({
      answerFn: async (_b, _q, history) => {
        seen.push([...history]);
        return { text: 'r', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    });
    await handleMessage(dm('QZ-252'), deps);
    await handleMessage(dm('quem validou?'), deps);
    await handleMessage(dm('AGL-900'), deps);
    expect(seen[2]).toEqual([]); // new card, fresh conversation
  });

  it('keeps conversations independent', async () => {
    const { deps } = makeDeps();
    await handleMessage(dm('QZ-252', 'conv-a'), deps);
    const replies = await handleMessage(dm('quem validou?', 'conv-b'), deps);
    expect(textOf(replies[0])).toContain('referência');
  });
});

describe('the bare-number guard (plan §6.1)', () => {
  it('does not rebind on a bare number when a card is already bound', async () => {
    const { deps, answered, loaded } = makeDeps();
    await handleMessage(dm('QZ-252'), deps);
    await handleMessage(dm('16467'), deps);
    expect(loaded).toHaveLength(1); // still the original card
    expect(answered[1]).toBe('16467'); // treated as a question, not a reference
  });

  it('binds a bare number as a Zendesk ticket when nothing is bound', async () => {
    const { deps, loaded } = makeDeps();
    await handleMessage(dm('16467'), deps);
    expect(loaded).toEqual([{ system: 'zendesk', ticketId: '16467', explicit: false }]);
  });
});

describe('staleness', () => {
  it('refetches when the bundle is older than 15 minutes', async () => {
    const { deps, loaded, setNow } = makeDeps();
    await handleMessage(dm('QZ-252'), deps);
    setNow(T0 + BUNDLE_TTL_MS + 1);
    await handleMessage(dm('e agora?'), deps);
    expect(loaded).toHaveLength(2);
  });

  it('does not refetch inside the window', async () => {
    const { deps, loaded, setNow } = makeDeps();
    await handleMessage(dm('QZ-252'), deps);
    setNow(T0 + BUNDLE_TTL_MS);
    await handleMessage(dm('e agora?'), deps);
    expect(loaded).toHaveLength(1);
  });
});

describe('commands', () => {
  it('atualizar refetches and confirms', async () => {
    const { deps, loaded } = makeDeps();
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('atualizar'), deps);
    expect(loaded).toHaveLength(2);
    expect(textOf(replies[0])).toContain('coletado às');
  });

  it('atualizar with nothing bound says so', async () => {
    const { deps, loaded } = makeDeps();
    const replies = await handleMessage(dm('atualizar'), deps);
    expect(loaded).toHaveLength(0);
    expect(textOf(replies[0])).toContain('referência');
  });

  it('ajuda works with and without a binding', async () => {
    const { deps } = makeDeps();
    expect(textOf((await handleMessage(dm('ajuda'), deps))[0])).toContain('chamado');
    await handleMessage(dm('QZ-252'), deps);
    expect(textOf((await handleMessage(dm('ajuda'), deps))[0])).toContain('QZ-252');
  });
});

describe('errors', () => {
  it('reports a card that was not found without binding anything', async () => {
    const { deps } = makeDeps({
      loadBundle: async () => ({ status: 'not_found', message: 'Não encontrei o card QZ-999.' }),
    });
    const replies = await handleMessage(dm('QZ-999'), deps);
    expect(textOf(replies[0])).toContain('QZ-999');
    expect(await deps.store.get({ scope: 'shared', conversationId: 'conv' })).toBeUndefined();
  });

  it('asks for a key on a multi-match, and never offers a numbered menu', async () => {
    const { deps } = makeDeps({
      loadBundle: async () => ({ status: 'ambiguous', side: 'jira', candidates: ['QZ-252', 'AGL-1500'] }),
    });
    const replies = await handleMessage(dm('chamado 16467'), deps);
    expect(textOf(replies[0])).toContain('QZ-252');
    expect(textOf(replies[0])).toContain('AGL-1500');
    expect(textOf(replies[0])).toContain('chave');
    expect(textOf(replies[0])).not.toMatch(/^\s*1\)/m); // a numbered reply would collide with §6.1
  });

  it('reports a tenant failure in pt-BR instead of throwing', async () => {
    const { deps } = makeDeps({ loadBundle: async () => { throw new Error('ECONNREFUSED'); } });
    const replies = await handleMessage(dm('QZ-252'), deps);
    expect(textOf(replies[0])).toMatch(/Jira|Zendesk/);
    expect(textOf(replies[0])).not.toContain('ECONNREFUSED');
  });

  it('reports an answer-service failure in pt-BR and keeps the binding', async () => {
    const { deps } = makeDeps({ answerFn: async () => { throw new Error('429 rate limit'); } });
    const replies = await handleMessage(dm('QZ-252'), deps);
    expect(textOf(replies[0])).not.toContain('429');
    expect(textOf(replies[0]).length).toBeGreaterThan(0);
  });

  it('prompts for a reference when nothing is bound and the text is not one', async () => {
    const { deps } = makeDeps();
    const replies = await handleMessage(dm('bom dia, tudo bem?'), deps);
    expect(textOf(replies[0])).toContain('referência');
  });
});

describe('disambiguation renders candidates by side (finding 3)', () => {
  it('keeps Jira candidates as bare keys — they already round-trip as explicit references', async () => {
    const { deps } = makeDeps({
      loadBundle: async () => ({ status: 'ambiguous', side: 'jira', candidates: ['QZ-252', 'AGL-1500'] }),
    });
    const replies = await handleMessage(dm('chamado 16467'), deps);
    expect(textOf(replies[0])).toContain('- QZ-252');
    expect(textOf(replies[0])).toContain('- AGL-1500');
  });

  it('renders Zendesk candidates as "chamado <n>", and the offered string rebinds correctly on reply', async () => {
    // Failure scenario from the finding: bound to QZ-100, user sends QZ-252 which is ambiguous
    // on the Zendesk side, the bot lists ticket numbers, the user replies with one of them.
    // A bare "16467" would be read as a QUESTION about QZ-100 by the bare-number guard; the
    // offered string must be explicit enough to actually rebind.
    const seenRefs: unknown[] = [];
    const { deps } = makeDeps({
      loadBundle: async (ref) => {
        seenRefs.push(ref);
        if (ref.system === 'jira' && ref.issueKey === 'QZ-100') {
          return { status: 'ok', bundle: bundleFor('QZ-100', '99999') } as AssembleResult;
        }
        if (ref.system === 'jira' && ref.issueKey === 'QZ-252') {
          return { status: 'ambiguous', side: 'zendesk', candidates: ['16467', '16468'] } as AssembleResult;
        }
        if (ref.system === 'zendesk' && ref.ticketId === '16467') {
          return { status: 'ok', bundle: bundleFor('QZ-999', '16467') } as AssembleResult;
        }
        throw new Error(`unexpected ref in test: ${JSON.stringify(ref)}`);
      },
    });

    await handleMessage(dm('QZ-100'), deps);

    const ambiguous = await handleMessage(dm('QZ-252'), deps);
    expect(textOf(ambiguous[0])).not.toMatch(/^- 16467$/m); // a bare number would collide with §6.1
    expect(textOf(ambiguous[0])).not.toMatch(/^- 16468$/m);
    expect(textOf(ambiguous[0])).toContain('- chamado 16467');
    expect(textOf(ambiguous[0])).toContain('- chamado 16468');

    // Round trip: reply with exactly the string the bot offered.
    const rebind = await handleMessage(dm('chamado 16467'), deps);
    expect(seenRefs.at(-1)).toEqual({ system: 'zendesk', ticketId: '16467', explicit: true });
    expect(textOf(rebind[0])).toContain('QZ-999'); // rebound to the new card, not answered from QZ-100
  });
});

describe('refresh() preserves specific errors instead of flattening to JIRA_UNAVAILABLE (finding 5)', () => {
  it('atualizar reports not_found distinctly when the bound card has been deleted', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      loadBundle: async () => {
        calls += 1;
        if (calls === 1) return { status: 'ok', bundle: bundleFor('QZ-252', '16467') } as AssembleResult;
        return { status: 'not_found', message: 'Não encontrei o card QZ-252.' } as AssembleResult;
      },
    });
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('atualizar'), deps);
    expect(textOf(replies[0])).toBe('Não encontrei o card QZ-252.');
    expect(textOf(replies[0])).not.toBe(JIRA_UNAVAILABLE);
  });

  it('atualizar reports the disambiguation key list distinctly on an ambiguous refetch', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      loadBundle: async () => {
        calls += 1;
        if (calls === 1) return { status: 'ok', bundle: bundleFor('QZ-252', '16467') } as AssembleResult;
        return { status: 'ambiguous', side: 'jira', candidates: ['QZ-252', 'AGL-1500'] } as AssembleResult;
      },
    });
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('atualizar'), deps);
    expect(textOf(replies[0])).toContain('chave');
    expect(textOf(replies[0])).not.toBe(JIRA_UNAVAILABLE);
  });

  it('a stale-bundle refresh reports not_found distinctly instead of the generic retry message', async () => {
    let calls = 0;
    const { deps, setNow } = makeDeps({
      loadBundle: async () => {
        calls += 1;
        if (calls === 1) return { status: 'ok', bundle: bundleFor('QZ-252', '16467') } as AssembleResult;
        return { status: 'not_found', message: 'Não encontrei o card QZ-252.' } as AssembleResult;
      },
    });
    await handleMessage(dm('QZ-252'), deps);
    setNow(T0 + BUNDLE_TTL_MS + 1);
    const replies = await handleMessage(dm('e agora?'), deps);
    expect(textOf(replies[0])).toBe('Não encontrei o card QZ-252.');
    expect(textOf(replies[0])).not.toBe(JIRA_UNAVAILABLE);
  });
});

describe('surface threading (spec §2)', () => {
  it('loads a dm bundle for a personal conversation', async () => {
    const surfaces: string[] = [];
    const { deps } = makeDeps({
      loadBundle: async (_ref, surface) => {
        surfaces.push(surface);
        return { status: 'ok', bundle: bundleFor('QZ-252', '16467') } as AssembleResult;
      },
    });
    await handleMessage(
      { text: 'QZ-252', conversationId: 'c', conversationType: 'personal', userId: 'u' },
      deps,
    );
    expect(surfaces).toEqual(['dm']);
  });

  it('loads a multiparty bundle for a channel, suppressing internal notes', async () => {
    const surfaces: string[] = [];
    const { deps } = makeDeps({
      loadBundle: async (_ref, surface) => {
        surfaces.push(surface);
        return { status: 'ok', bundle: bundleFor('QZ-252', '16467') } as AssembleResult;
      },
    });
    await handleMessage(
      { text: 'QZ-252', conversationId: 'c', conversationType: 'channel', userId: 'u' },
      deps,
    );
    expect(surfaces).toEqual(['multiparty']);
  });

  it('refreshes with the same surface it bound with', async () => {
    const surfaces: string[] = [];
    const { deps } = makeDeps({
      loadBundle: async (_ref, surface) => {
        surfaces.push(surface);
        return { status: 'ok', bundle: bundleFor('QZ-252', '16467') } as AssembleResult;
      },
    });
    const chan = { conversationId: 'c', conversationType: 'groupChat', userId: 'u' };
    await handleMessage({ ...chan, text: 'QZ-252' }, deps);
    await handleMessage({ ...chan, text: 'atualizar' }, deps);
    expect(surfaces).toEqual(['multiparty', 'multiparty']);
  });
});

describe('shared thread with personal splits (spec §4)', () => {
  it('answers a second users follow-up from the shared binding', async () => {
    const { deps, answered } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'quem validou?' }, deps);
    expect(answered[1]).toBe('quem validou?');
    expect(await deps.store.get({ scope: 'shared', conversationId: 'thread' })).toBeDefined();
  });

  it('a reference WITH a question splits that user off without moving the thread', async () => {
    const { deps, loaded } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);

    const sharedBinding = await deps.store.get({ scope: 'shared', conversationId: 'thread' });
    const brunoBinding = await deps.store.get({
      scope: 'personal', conversationId: 'thread', userId: 'bruno',
    });
    expect(sharedBinding).toBeDefined();
    expect(brunoBinding).toBeDefined();
    expect((sharedBinding?.ref as { issueKey: string }).issueKey).toBe('QZ-252');
    expect((brunoBinding?.ref as { issueKey: string }).issueKey).toBe('AGL-900');
    expect(loaded).toHaveLength(2);
  });

  it('resolves personal before shared for the split user, and shared for everyone else', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      answerFn: async (bundle, question) => {
        seen.push(`${bundle.jira?.issueKey}:${question}`);
        return { text: 'r', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    });
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);
    await handleMessage({ ...bruno, text: 'e o prazo?' }, deps);
    await handleMessage({ ...ana, text: 'quem validou?' }, deps);
    expect(seen[2]).toBe('AGL-900:e o prazo?');
    expect(seen[3]).toBe('QZ-252:quem validou?');
  });

  it('a BARE reference moves the thread and rejoins the sender', async () => {
    const { deps } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);
    await handleMessage({ ...bruno, text: 'SC-10' }, deps);

    const sharedBinding = await deps.store.get({ scope: 'shared', conversationId: 'thread' });
    expect(sharedBinding).toBeDefined();
    expect((sharedBinding?.ref as { issueKey: string }).issueKey).toBe('SC-10');
    expect(
      await deps.store.get({ scope: 'personal', conversationId: 'thread', userId: 'bruno' }),
    ).toBeUndefined();
  });

  it('voltar clears the personal binding and returns the user to the thread', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      answerFn: async (bundle, question) => {
        seen.push(`${bundle.jira?.issueKey}:${question}`);
        return { text: 'r', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    });
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);
    await handleMessage({ ...bruno, text: 'voltar' }, deps);
    await handleMessage({ ...bruno, text: 'quem validou?' }, deps);
    expect(seen[seen.length - 1]).toBe('QZ-252:quem validou?');
  });

  it('voltar with no personal binding says so in pt-BR', async () => {
    const { deps } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    const replies = await handleMessage({ ...bruno, text: 'voltar' }, deps);
    expect(textOf(replies[0])).toBe(NOT_SPLIT);
  });

  it('voltar with a split but no shared binding says there is no thread card to rejoin, not NOTHING_BOUND, and keeps the split (review finding: Minor 6)', async () => {
    const { deps } = makeDeps();
    // bruno splits off in a thread where nobody has ever bound the shared card.
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);
    const replies = await handleMessage({ ...bruno, text: 'voltar' }, deps);
    // NOTHING_BOUND ("não sei de qual card estamos falando") would contradict the bot's own
    // state: bruno's personal split IS a bound card, just not a thread card to return to.
    expect(textOf(replies[0])).toContain(NO_THREAD_TO_REJOIN);
    expect(textOf(replies[0])).not.toBe(NOTHING_BOUND);
    expect(textOf(replies[0])).toContain('AGL-900'); // names the card that is still bound

    const brunoBinding = await deps.store.get({
      scope: 'personal', conversationId: 'thread', userId: 'bruno',
    });
    expect(brunoBinding).toBeDefined();
    expect((brunoBinding?.ref as { issueKey: string }).issueKey).toBe('AGL-900');
  });

  it('keeps two threads independent', async () => {
    const { deps } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    const replies = await handleMessage(
      { conversationId: 'other', conversationType: 'channel', userId: 'ana', text: 'quem validou?' },
      deps,
    );
    expect(textOf(replies[0])).toBe(NOTHING_BOUND);
  });
});

describe('a split users writes stay in the personal slot (review finding: Important 3)', () => {
  it('accumulates a split users conversation history in the personal slot, leaving the shared history untouched', async () => {
    const { deps } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    const sharedAfterAna = await deps.store.get({ scope: 'shared', conversationId: 'thread' });

    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);
    await handleMessage({ ...bruno, text: 'e o prazo?' }, deps);

    const sharedAfterBruno = await deps.store.get({ scope: 'shared', conversationId: 'thread' });
    const brunoBinding = await deps.store.get({
      scope: 'personal', conversationId: 'thread', userId: 'bruno',
    });
    // The shared binding is exactly as ana's own turn left it -- bruno's exchanges never touched it.
    expect(sharedAfterBruno?.history).toEqual(sharedAfterAna?.history);
    expect(brunoBinding).toBeDefined();
    expect((brunoBinding?.history.length ?? 0)).toBeGreaterThan(0);
  });

  it('atualizar from a split user refreshes only the personal bundle, leaving the shared bundleFetchedAt untouched', async () => {
    const { deps, loaded, setNow } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);
    const sharedBefore = await deps.store.get({ scope: 'shared', conversationId: 'thread' });

    setNow(T0 + 1_000);
    await handleMessage({ ...bruno, text: 'atualizar' }, deps);

    const sharedAfter = await deps.store.get({ scope: 'shared', conversationId: 'thread' });
    const brunoBinding = await deps.store.get({
      scope: 'personal', conversationId: 'thread', userId: 'bruno',
    });
    expect(sharedAfter?.bundleFetchedAt).toBe(sharedBefore?.bundleFetchedAt);
    expect(brunoBinding?.bundleFetchedAt).toBe(T0 + 1_000);
    expect(loaded).toHaveLength(3); // ana's bind, bruno's bind, bruno's atualizar
  });

  it('a staleness refresh for a split user writes the refreshed bundle to the personal slot', async () => {
    const { deps, loaded, setNow } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);

    setNow(T0 + BUNDLE_TTL_MS + 1);
    await handleMessage({ ...bruno, text: 'e o prazo?' }, deps);

    const brunoBinding = await deps.store.get({
      scope: 'personal', conversationId: 'thread', userId: 'bruno',
    });
    const sharedBinding = await deps.store.get({ scope: 'shared', conversationId: 'thread' });
    expect(brunoBinding?.bundleFetchedAt).toBe(T0 + BUNDLE_TTL_MS + 1);
    expect(sharedBinding?.bundleFetchedAt).toBe(T0); // ana's binding was never touched
    expect(loaded).toHaveLength(3); // ana's bind, bruno's bind, bruno's stale refresh
  });
});

describe('a failed rebind must not destroy an existing binding (review finding: Important 1)', () => {
  it('channel: bruno keeps his personal split after a bad bare reference', async () => {
    const { deps } = makeDeps({
      loadBundle: async (ref) => {
        if (ref.system === 'jira' && ref.issueKey === 'QZ-999') {
          return { status: 'not_found', message: 'Não encontrei o card QZ-999.' } as AssembleResult;
        }
        const key = ref.system === 'jira' ? ref.issueKey : 'QZ-252';
        return { status: 'ok', bundle: bundleFor(key, '16467') } as AssembleResult;
      },
    });
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);

    const replies = await handleMessage({ ...bruno, text: 'QZ-999' }, deps);
    expect(textOf(replies[0])).toContain('QZ-999');

    const brunoBinding = await deps.store.get({
      scope: 'personal', conversationId: 'thread', userId: 'bruno',
    });
    expect(brunoBinding).toBeDefined();
    expect((brunoBinding?.ref as { issueKey: string }).issueKey).toBe('AGL-900');

    // The next follow-up must still be answered against bruno's surviving split, not the shared card.
    const followUp = await handleMessage({ ...bruno, text: 'e o prazo?' }, deps);
    expect(textOf(followUp[0])).not.toBe(NOTHING_BOUND);
  });

  it('DM: the previous binding survives a bad bare reference (Phase 3 collapse)', async () => {
    const { deps, answered } = makeDeps({
      loadBundle: async (ref) => {
        if (ref.system === 'jira' && ref.issueKey === 'QZ-999') {
          return { status: 'not_found', message: 'Não encontrei o card QZ-999.' } as AssembleResult;
        }
        return { status: 'ok', bundle: bundleFor('QZ-252', '16467') } as AssembleResult;
      },
    });
    await handleMessage(dm('QZ-252'), deps);
    const failed = await handleMessage(dm('QZ-999'), deps);
    expect(textOf(failed[0])).toContain('QZ-999');

    const replies = await handleMessage(dm('quem validou?'), deps);
    expect(textOf(replies[0])).not.toBe(NOTHING_BOUND);
    expect(answered.at(-1)).toBe('quem validou?'); // still answered on QZ-252, per Phase 3
  });
});

describe('cards (spec §5)', () => {
  it('answers with a card carrying a plain-text fallback', async () => {
    const { deps } = makeDeps();
    const replies = await handleMessage(
      { text: 'QZ-252', conversationId: 'c', conversationType: 'personal', userId: 'u' }, deps,
    );
    expect(replies[0].kind).toBe('card');
    if (replies[0].kind === 'card') {
      expect(replies[0].card.type).toBe('AdaptiveCard');
      expect(replies[0].fallbackText).toContain('coletado às');
    }
  });

  it('compresses raw citations at display time in both the card body and the fallbackText', async () => {
    const { deps } = makeDeps({
      answerFn: async () => ({
        text: 'Falhou [comentário jira 11] e [comentário zendesk 40123456789] [campo Status]',
        model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    });
    const replies = await handleMessage(dm('QZ-252'), deps);
    expect(replies[0].kind).toBe('card');
    if (replies[0].kind === 'card') {
      const compressed = '[jira 11] e [zendesk …6789] [Status]';
      // The card additionally italicises each citation (cards.ts styleCitations), so the
      // compressed forms appear individually there rather than as one contiguous string.
      const cardJson = JSON.stringify(replies[0].card);
      for (const citation of ['[jira 11]', '[zendesk …6789]', '[Status]']) {
        expect(cardJson).toContain(`_${citation}_`);
      }
      expect(cardJson).not.toContain('comentário');
      expect(replies[0].fallbackText).toContain(compressed);
      expect(replies[0].fallbackText).not.toContain('comentário');
    }
  });

  it('marks a split users card as personal in a channel', async () => {
    const { deps } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    const replies = await handleMessage({ ...bruno, text: 'AGL-900 qual o status?' }, deps);
    expect(JSON.stringify(replies[0])).toContain(PERSONAL_MARKER);
  });

  it('does NOT mark a DM personal-slot answer as personal (review finding: Important 3 / cards.ts leak)', async () => {
    // "QZ-252 quem validou?" is a reference-with-question -- it binds the PERSONAL slot even in
    // a DM (spec §4's table applies unconditionally). Without the surface check, the header would
    // read "**QZ-252** ↔ chamado 16467 · sua consulta" in a 1:1 chat, where there is no thread and
    // no other reader for the marker to mean anything to -- the one visible break in §4's
    // "collapses to exactly Phase 3 in a DM" guarantee.
    const { deps } = makeDeps();
    const replies = await handleMessage(dm('QZ-252 quem validou?'), deps);
    expect(JSON.stringify(replies[0])).not.toContain(PERSONAL_MARKER);
  });

  it('sends errors and help as text, not cards', async () => {
    const { deps } = makeDeps();
    const replies = await handleMessage(
      { text: 'ajuda', conversationId: 'c', conversationType: 'personal', userId: 'u' }, deps,
    );
    expect(replies[0].kind).toBe('text');
  });

  it('falls back to text when the card builder throws', async () => {
    const { deps } = makeDeps({ buildCard: () => { throw new Error('bad card'); } });
    const replies = await handleMessage(
      { text: 'QZ-252', conversationId: 'c', conversationType: 'personal', userId: 'u' }, deps,
    );
    expect(replies[0].kind).toBe('text');
    expect(textOf(replies[0])).toContain('coletado às');
  });
});

describe('handleRefresh (spec §6)', () => {
  it('produces the same result as typing atualizar', async () => {
    const { deps, loaded } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    const viaCommand = await handleMessage({ ...ana, text: 'atualizar' }, deps);
    const viaButton = await handleRefresh(ana, deps);
    expect(textOf(viaButton[0])).toBe(textOf(viaCommand[0]));
    expect(loaded).toHaveLength(3);
  });

  it('replies in pt-BR when nothing is bound', async () => {
    const { deps } = makeDeps();
    const replies = await handleRefresh(ana, deps);
    expect(textOf(replies[0])).toBe(NOTHING_BOUND);
  });
});

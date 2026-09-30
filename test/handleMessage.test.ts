import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_UNAVAILABLE, handleMessage, handleRefresh, handleSelect, JIRA_UNAVAILABLE, NOT_SPLIT, NO_THREAD_TO_REJOIN, NOTHING_BOUND,
  SEARCH_NONE, SEARCH_UNAVAILABLE, SELECTION_INVALID, HELP_TEXT, handleSwitchBuscar, handleSwitchContinuar,
  handleReminderPick, handleReminderSend, handleReminderCancel,
  type HandleDeps, type Incoming,
} from '@/teams/handleMessage.js';
import {
  NOT_IN_ORG, NOTE_TOO_LONG, NOTE_MAX_CHARS, NO_ASSIGNEE_REPLY, REMINDER_NEEDS_CARD, REMIND_PICK_ACTION,
  REMIND_SEND_ACTION, REMINDER_EXPIRED, UNCONFIGURED_DIRECTORY, REMINDER_SENT, REMINDER_SEND_FAILED, REMINDER_CANCELLED,
  REMINDER_REASSIGNED, UNCONFIGURED_SEND, UNKNOWN_REQUESTER, type ReminderSenderLike,
} from '@/teams/reminder.js';
import { DIRECTORY_UNAVAILABLE, type DirectoryUser } from '@/msgraph/directory.js';
import { BUSCAR_ACTION, CONTINUAR_ACTION } from '@/teams/rundown.js';
import { InMemoryCandidateStore } from '@/teams/candidates.js';
import { renderRundown, SECTION_LINE_CAP, STALE_AFTER_DAYS } from '@/teams/rundown.js';
import { DAY_MS } from '@/text/datetime.js';
import { MAX_HISTORY_TURNS } from '@/claude/prompt.js';
import type { CardCandidate, SearchOutcome } from '@/teams/search.js';
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
    answerPortfolioFn: async () => {
      throw new Error('answerPortfolioFn should not be called in these tests');
    },
    cfg: testConfig,
    now: () => now,
    candidates: new InMemoryCandidateStore(() => now),
    search: async () => {
      throw new Error('search should not be called in these tests');
    },
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
    // Compression is display-only: the stored history keeps the model's RAW text.
    const stored = await deps.store.get({ scope: 'shared', conversationId: CONV });
    const lastTurn = stored?.history.at(-1);
    expect(lastTurn?.role).toBe('assistant');
    expect(lastTurn?.text).toContain('[comentário jira 11]');
    expect(lastTurn?.text).toContain('[comentário zendesk 40123456789]');
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


describe('busca de portfólio', () => {
  const jiraCard = (key: string, summary: string): CardCandidate => ({
    ref: { system: 'jira', issueKey: key, explicit: true },
    label: key, summary, status: 'Em Teste', updatedAt: '2026-09-20T10:00:00.000Z',
  });
  const cardsOutcome = (cards: CardCandidate[], name = 'norte', displayName = name): SearchOutcome =>
    ({ kind: 'cards', name, displayName, cards, total: cards.length });
  const two = [jiraCard('AGL-11', 'Reforma do telhado'), jiraCard('AGL-12', 'Pintura externa')];
  const bindOutcome: SearchOutcome = {
    kind: 'bind',
    displayName: 'NORTE CONSTRUTORA',
    candidate: {
      ref: { system: 'zendesk', ticketId: '16467', explicit: true },
      label: 'chamado 16467', summary: 'Aplicativo travando', status: 'open',
      updatedAt: '2026-09-28T10:00:00.000Z',
    },
  };
  const req = { conversationId: CONV, conversationType: 'personal', userId: 'u' };

  function withSearch(outcome: SearchOutcome | Error) {
    const searched: string[] = [];
    const made = makeDeps({
      search: async (name) => {
        searched.push(name);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    });
    return { ...made, searched };
  }
  const shared = { scope: 'shared' as const, conversationId: CONV };

  it('buscar searches with a binding present and does not unbind', async () => {
    const { deps, answered, searched } = withSearch(cardsOutcome(two));
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('buscar Norte'), deps);
    expect(searched).toEqual(['Norte']);
    expect(replies[0].kind).toBe('card');
    await handleMessage(dm('e o prazo?'), deps);
    expect(answered.at(-1)).toBe('e o prazo?');
  });

  it('detector fires only when nothing is bound and nothing parses', async () => {
    const { deps, searched } = withSearch(cardsOutcome(two));
    const replies = await handleMessage(dm('como está a empresa Norte?'), deps);
    expect(searched).toEqual(['Norte']);
    expect(replies).toHaveLength(1);
    expect(replies[0].kind).toBe('card');
    expect(textOf(replies[0])).toContain('atividades abertas');
  });

  // Amended by spec §11: entity wording mid-sentence now raises the confirm card instead of going
  // straight to the card. The property this test protects survives: nothing is searched or
  // silently stolen, and the original question reaches answerFn untouched once the user picks
  // "Continuar" (same handler the button invokes).
  it('a genuine question with a binding and empresa/obra wording reaches answerFn untouched via Continuar', async () => {
    const { deps, answered, searched } = withSearch(cardsOutcome(two));
    await handleMessage(dm('QZ-252'), deps);
    const q = 'como está a empresa Norte na obra da fundação?';
    const before = answered.length;
    const confirm = await handleMessage(dm(q), deps);
    expect(confirm[0].kind).toBe('card');
    expect(searched).toEqual([]);
    expect(answered.length).toBe(before);
    const replies = await handleSwitchContinuar(req, { action: CONTINUAR_ACTION, text: q }, deps);
    expect(searched).toEqual([]);
    expect(answered.at(-1)).toBe(q);
    expect(textOf(replies[0])).toContain(`resposta para: ${q}`);
  });

  it('orgs outcome renders the choice text', async () => {
    const { deps } = withSearch({ kind: 'orgs', name: 'norte', orgs: [{ id: 1, name: 'Norte A' }, { id: 2, name: 'Norte B' }] });
    const replies = await handleMessage(dm('buscar norte'), deps);
    expect(textOf(replies[0])).toContain('Norte A');
    expect(textOf(replies[0])).toContain('buscar <nome da organização>');
  });

  it('cards outcome stores the set and replies with a button card carrying system+id', async () => {
    const { deps } = withSearch(cardsOutcome(two));
    const replies = await handleMessage(dm('buscar norte'), deps);
    const reply = replies[0];
    expect(reply.kind).toBe('card');
    if (reply.kind !== 'card') throw new Error('unreachable');
    const actions = (reply.card as { actions: Array<{ data: Record<string, string> }> }).actions;
    expect(actions[0].data).toMatchObject({ system: 'jira', id: 'AGL-11' });
    expect(reply.fallbackText).toContain('AGL-11');
    const set = await deps.candidates.get(shared);
    expect(set?.candidates).toHaveLength(2);
  });

  it('rundown mode replies with a rundown card (fallbackText = the text rundown) and still stores the set', async () => {
    const { deps, loaded } = withSearch(cardsOutcome(two));
    const replies = await handleMessage(dm('como estão os projetos da empresa Norte'), deps);
    expect(replies[0].kind).toBe('card');
    expect(textOf(replies[0])).toContain('2 atividades abertas');
    const reply = replies[0];
    if (reply.kind !== 'card') throw new Error('unreachable');
    expect(reply.fallbackText).toBe(renderRundown('norte', two, 2, T0, testConfig));
    expect((reply.card as { actions?: unknown }).actions).toBeUndefined();   // a rundown never offers buttons
    expect(loaded).toHaveLength(0);
    expect((await deps.candidates.get(shared))?.candidates).toHaveLength(2);
  });

  it('exact label selection binds, KEEPS the set (spec §2 "NOT cleared by a card bind") and answers the summary (spec §5a)', async () => {
    const { deps, loaded, answered } = withSearch(cardsOutcome(two));
    await handleMessage(dm('buscar norte'), deps);
    const replies = await handleMessage(dm('AGL-11'), deps);
    expect(loaded).toEqual([{ system: 'jira', issueKey: 'AGL-11', explicit: true }]);
    expect(answered).toHaveLength(1);
    expect(textOf(replies[0])).toContain('resposta para:');
    expect((await deps.candidates.get(shared))?.candidates).toHaveLength(2);
  });

  it('substring text falls through; portfolio queries trigger search (spec §5a)', async () => {
    const { deps, searched, loaded } = withSearch(cardsOutcome([jiraCard('AGL-11', 'Obra norte fase 1'), jiraCard('AGL-12', 'Obra norte fase 2')]));
    await handleMessage(dm('buscar norte'), deps);
    const replies = await handleMessage(dm('obra norte'), deps);
    // "obra norte" is a portfolio query (contains "obra" KIND), so it triggers search("norte") again
    expect(searched).toContain('norte');
    expect(loaded).toHaveLength(0);
    // Returns the rundown (since it matches the portfolio query pattern)
    expect(textOf(replies[0])).toContain('Obra norte fase 1');
  });

  it('non-matching text with a set stored falls through to the bound card question', async () => {
    const { deps, answered } = withSearch(cardsOutcome(two));
    await handleMessage(dm('QZ-252'), deps);
    await handleMessage(dm('buscar norte'), deps);
    await handleMessage(dm('qual o status atual?'), deps);
    expect(answered.at(-1)).toBe('qual o status atual?');
  });

  it('a successful reference rebind KEEPS the portfolio set (spec §2 "NOT cleared by a card bind")', async () => {
    const { deps } = withSearch(cardsOutcome(two));
    await handleMessage(dm('buscar norte'), deps);
    expect(await deps.candidates.get(shared)).toBeDefined();
    await handleMessage(dm('QZ-252'), deps);
    expect((await deps.candidates.get(shared))?.candidates).toHaveLength(2);
  });

  it('a failed rebind keeps the candidate set', async () => {
    const { deps } = withSearch(cardsOutcome(two));
    await handleMessage(dm('buscar norte'), deps);
    deps.loadBundle = async () => ({ status: 'not_found', message: 'nada' }) as AssembleResult;
    await handleMessage(dm('QZ-999'), deps);
    expect(await deps.candidates.get(shared)).toBeDefined();
  });

  it('search bind outcome binds and answers the summary', async () => {
    const { deps, loaded, answered } = withSearch(bindOutcome);
    const replies = await handleMessage(dm('buscar norte'), deps);
    expect(loaded).toHaveLength(1);
    expect(answered).toHaveLength(1);
    expect(textOf(replies[0])).toContain('resposta para:');
  });

  it('search throwing replies SEARCH_UNAVAILABLE', async () => {
    const { deps } = withSearch(new Error('boom'));
    const replies = await handleMessage(dm('buscar norte'), deps);
    expect(replies).toHaveLength(1);
    expect(textOf(replies[0])).toBe(SEARCH_UNAVAILABLE);
  });

  it('none outcome replies SEARCH_NONE', async () => {
    const { deps } = withSearch({ kind: 'none', name: 'norte' });
    const replies = await handleMessage(dm('buscar norte'), deps);
    expect(textOf(replies[0])).toBe(SEARCH_NONE('norte'));
  });

  it('nothing bound and no detector hit still replies NOTHING_BOUND', async () => {
    const { deps } = withSearch({ kind: 'none', name: 'x' });
    const replies = await handleMessage(dm('oi tudo bem'), deps);
    expect(textOf(replies[0])).toBe(NOTHING_BOUND);
  });

  it('uses "atividades abertas" terminology in SEARCH_NONE and the help text', () => {
    expect(SEARCH_NONE('norte')).toBe('Não encontrei atividades abertas para "norte". Tente outro nome, ou use `buscar <nome>`.');
    expect(HELP_TEXT).toContain('`buscar` + nome — procura atividades abertas por empresa, cliente ou obra');
    expect(HELP_TEXT).not.toContain('cards ativos');
  });

  it('HELP_TEXT mentions buscar', () => {
    expect(HELP_TEXT).toContain('`buscar` + nome');
  });

  it('HELP_TEXT mentions portfolio follow-up affordances', () => {
    expect(HELP_TEXT).toContain('`quantos?`');
    expect(HELP_TEXT).toContain('`todos os de jira`');
  });

  it('HELP_TEXT mentions lembrar responsável', () => {
    expect(HELP_TEXT).toContain('`lembrar responsável`');
  });

  it('handleSelect binds with no candidate set present', async () => {
    const { deps, loaded } = makeDeps();
    const replies = await handleSelect(req, { system: 'jira', id: 'AGL-11' }, deps);
    expect(loaded).toEqual([{ system: 'jira', issueKey: 'AGL-11', explicit: true }]);
    expect(textOf(replies[0])).toContain('resposta para:');
    expect(await deps.store.get(shared)).toBeDefined();
  });

  it('handleSelect builds a zendesk ref and KEEPS the set (spec §2 "NOT cleared by a card bind")', async () => {
    const { deps, loaded } = withSearch(cardsOutcome(two));
    await handleMessage(dm('buscar norte'), deps);
    await handleSelect(req, { system: 'zendesk', id: '16467' }, deps);
    expect(loaded).toEqual([{ system: 'zendesk', ticketId: '16467', explicit: true }]);
    expect((await deps.candidates.get(shared))?.candidates).toHaveLength(2);
  });

  it('handleSelect with a garbage payload replies pt-BR and never throws', async () => {
    const { deps, loaded } = makeDeps();
    const bad = [{}, { system: 'github', id: 'x' }, { system: 'jira', id: '' }, { system: 'jira' }, { system: 'jira', id: 5 as unknown as string }];
    for (const data of bad) {
      const replies = await handleSelect(req, data, deps);
      expect(replies).toHaveLength(1);
      expect(textOf(replies[0])).toBe(SELECTION_INVALID);
    }
    expect(loaded).toHaveLength(0);
  });

  it('handleSelect rejects ids outside the allowed projects or shaped like paths/JQL, before any fetch', async () => {
    const { deps, loaded } = makeDeps();
    const bad = [
      { system: 'jira', id: 'ZZ-1' },                 // project not in allowedProjects
      { system: 'jira', id: '../AGL-11' },            // path traversal around a valid key
      { system: 'jira', id: 'AGL-11/../../x' },
      { system: 'jira', id: 'AGL-11 OR project=SEC' },
      { system: 'jira', id: 'https://x.atlassian.net/browse/AGL-11' },
      { system: 'zendesk', id: 'abc' },
      { system: 'zendesk', id: '123/../users' },
      { system: 'zendesk', id: '16467?x=1' },
    ];
    for (const data of bad) {
      const replies = await handleSelect(req, data, deps);
      expect(replies).toHaveLength(1);
      expect(textOf(replies[0])).toBe(SELECTION_INVALID);
    }
    expect(loaded).toHaveLength(0);
  });

  it('handleSelect still trims and accepts a valid key and a numeric ticket id', async () => {
    const { deps, loaded } = makeDeps();
    await handleSelect(req, { system: 'jira', id: ' AGL-11 ' }, deps);
    await handleSelect(req, { system: 'zendesk', id: ' 16467 ' }, deps);
    expect(loaded).toEqual([
      { system: 'jira', issueKey: 'AGL-11', explicit: true },
      { system: 'zendesk', ticketId: '16467', explicit: true },
    ]);
  });

  it('headers and the stored set use the matched displayName, not the typed query', async () => {
    const outcome = cardsOutcome(two, 'dalle', 'DALLÉ CONSTRUTORA');
    const { deps } = withSearch(outcome);
    const cardReply = (await handleMessage(dm('buscar dalle'), deps))[0];
    if (cardReply.kind !== 'card') throw new Error('unreachable');
    expect(cardReply.fallbackText.startsWith('**DALLÉ CONSTRUTORA — ')).toBe(true);
    expect(JSON.stringify(cardReply.card)).toContain('DALLÉ CONSTRUTORA — 2 atividades abertas');
    expect((await deps.candidates.get(shared))?.name).toBe('DALLÉ CONSTRUTORA');

    const rundown = (await handleMessage(dm('como estao os cards da dalle?'), deps))[0];
    expect(textOf(rundown).startsWith('**DALLÉ CONSTRUTORA — ')).toBe(true);
  });

  it('the one-candidate card (single match over a binding) is headed by the matched displayName', async () => {
    const { deps } = withSearch(bindOutcome);
    await handleMessage(dm('QZ-252'), deps);
    const reply = (await handleMessage(dm('buscar norte'), deps))[0];
    if (reply.kind !== 'card') throw new Error('unreachable');
    expect(JSON.stringify(reply.card)).toContain('NORTE CONSTRUTORA — 1 atividades abertas');
    expect((await deps.candidates.get(shared))?.name).toBe('NORTE CONSTRUTORA');
  });

  it('SEARCH_NONE keeps the typed name', async () => {
    const { deps } = withSearch({ kind: 'none', name: 'dalle' });
    expect(textOf((await handleMessage(dm('buscar dalle'), deps))[0])).toBe(SEARCH_NONE('dalle'));
  });

  it('buscar passes the name to search verbatim, accents and case intact', async () => {
    const { deps, searched } = withSearch(cardsOutcome(two));
    await handleMessage(dm('buscar São Bento'), deps);
    await handleMessage(dm('como está a empresa São Bento?'), deps);
    expect(searched).toEqual(['São Bento', 'São Bento']);
  });

  describe('typed selection while a card is bound (no hijack of the conversation)', () => {
    const list = [jiraCard('AGL-11', 'Sim ou não? Reforma'), jiraCard('QZ-300', 'Pintura'), jiraCard('agl-12', 'Fachada')];

    it('a substring of a summary falls through to the bound card question', async () => {
      const { deps, answered, loaded } = withSearch(cardsOutcome(list));
      await handleMessage(dm('QZ-252'), deps);
      await handleMessage(dm('buscar norte'), deps);
      const replies = await handleMessage(dm('sim'), deps);
      expect(answered.at(-1)).toBe('sim');
      expect(textOf(replies[0])).toContain('resposta para: sim');
      expect(loaded).toEqual([{ system: 'jira', issueKey: 'QZ-252', explicit: true }]);
    });

    it('substring falls through to the bound card question (spec §5a)', async () => {
      const amb = [jiraCard('AGL-11', 'Obra norte fase 1'), jiraCard('AGL-12', 'Obra norte fase 2')];
      const { deps, answered } = withSearch(cardsOutcome(amb));
      await handleMessage(dm('QZ-252'), deps);
      await handleMessage(dm('buscar norte'), deps);
      const replies = await handleMessage(dm('obra norte'), deps);
      // "obra norte" is not an exact label, so it never selects a candidate. Amended by spec §11:
      // it is anchored-detector-shaped, so the fallthrough is now the confirm card rather than a
      // direct answer; "Continuar" then delivers it to the bound card unchanged.
      expect(replies[0].kind).toBe('card');
      expect(answered.at(-1)).not.toBe('obra norte');
      const cont = await handleSwitchContinuar(req, { action: CONTINUAR_ACTION, text: 'obra norte' }, deps);
      expect(answered.at(-1)).toBe('obra norte');
      expect(textOf(cont[0])).toContain('resposta para: obra norte');
    });

    it('a bare number that is a substring of a key stays a question', async () => {
      const { deps, answered, loaded } = withSearch(cardsOutcome([jiraCard('QZ-252', 'Relatório'), jiraCard('QZ-300', 'Outro')]));
      await handleMessage(dm('QZ-300'), deps);
      await handleMessage(dm('buscar norte'), deps);
      await handleMessage(dm('252'), deps);
      expect(answered.at(-1)).toBe('252');
      expect(loaded).toEqual([{ system: 'jira', issueKey: 'QZ-300', explicit: true }]);
    });

    it('an exact label still selects', async () => {
      const { deps, loaded } = withSearch(cardsOutcome(list));
      await handleMessage(dm('QZ-252'), deps);
      await handleMessage(dm('buscar norte'), deps);
      await handleMessage(dm('agl-12'), deps);   // lower-case: not parsed as a reference, matches the label exactly
      expect(loaded.at(-1)).toEqual({ system: 'jira', issueKey: 'agl-12', explicit: true });
    });

    it('unbound substring no longer triggers selection; with a portfolio it goes to Claude-over-portfolio (spec §3.2, rerouted from NOTHING_BOUND)', async () => {
      // List: AGL-11 with summary containing "Pintura", AGL-12 with different summary
      const list = [jiraCard('AGL-11', 'Pintura do prédio'), jiraCard('AGL-12', 'Outro projeto')];
      const { deps, loaded } = withSearch(cardsOutcome(list));
      const asked: string[] = [];
      deps.answerPortfolioFn = async (_r, question) => {
        asked.push(question);
        return { text: 'sobre a pintura', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      };
      await handleMessage(dm('buscar norte'), deps);
      // "pintura" is a substring of the summary but not an exact label match (no selection), and
      // not a portfolio query pattern, so with a set stored it is a question about the portfolio.
      const replies = await handleMessage(dm('pintura'), deps);
      expect(asked).toEqual(['pintura']);
      expect(loaded).toHaveLength(0);
      expect(textOf(replies[0])).toContain('sobre a pintura');
    });
  });

  describe('a single search match with a card already bound', () => {
    it('offers a one-candidate card instead of rebinding', async () => {
      const { deps, loaded, answered } = withSearch(bindOutcome);
      await handleMessage(dm('QZ-252'), deps);
      const replies = await handleMessage(dm('buscar norte'), deps);
      expect(replies).toHaveLength(1);
      const reply = replies[0];
      expect(reply.kind).toBe('card');
      if (reply.kind !== 'card') throw new Error('unreachable');
      const actions = (reply.card as { actions: Array<{ data: Record<string, string> }> }).actions;
      expect(actions).toHaveLength(1);
      expect(actions[0].data).toMatchObject({ system: 'zendesk', id: '16467' });
      expect(loaded).toEqual([{ system: 'jira', issueKey: 'QZ-252', explicit: true }]);   // no rebind
      expect(answered).toHaveLength(1);                                                     // only QZ-252's summary
      expect((await deps.candidates.get(shared))?.candidates).toHaveLength(1);
      expect(((await deps.store.get(shared))?.ref as { issueKey: string }).issueKey).toBe('QZ-252');
    });

    it('with nothing bound it still binds directly', async () => {
      const { deps, loaded } = withSearch(bindOutcome);
      const replies = await handleMessage(dm('buscar norte'), deps);
      expect(replies[0].kind).toBe('card');   // the answer card, not a candidate card
      expect(loaded).toEqual([{ system: 'zendesk', ticketId: '16467', explicit: true }]);
    });
  });

  it('a button selection in a multiparty room clears the clicker\'s personal split only', async () => {
    const { deps } = makeDeps();
    await handleMessage({ ...ana, text: 'QZ-252' }, deps);
    await handleMessage({ ...ana, text: 'AGL-900 qual o status?' }, deps);
    await handleMessage({ ...bruno, text: 'SC-10 qual o status?' }, deps);
    const anaSplit = { scope: 'personal' as const, conversationId: 'thread', userId: 'ana' };
    const brunoSplit = { scope: 'personal' as const, conversationId: 'thread', userId: 'bruno' };
    expect(await deps.store.get(anaSplit)).toBeDefined();

    await handleSelect(ana, { system: 'jira', id: 'AGL-11' }, deps);

    expect(await deps.store.get(anaSplit)).toBeUndefined();
    expect(await deps.store.get(brunoSplit)).toBeDefined();
    const sharedBinding = await deps.store.get({ scope: 'shared', conversationId: 'thread' });
    expect((sharedBinding?.ref as { issueKey: string }).issueKey).toBe('AGL-11');
  });

  describe('portfolio follow-ups and switch-then-ask (spec §3/§3a/§4)', () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const turn = (i: number) => [
      { role: 'user' as const, text: `p${i}` },
      { role: 'assistant' as const, text: `r${i}` },
    ];
    /** withSearch + an answerPortfolioFn that records what it was handed. */
    function portfolioDeps(outcome: SearchOutcome = cardsOutcome(two)) {
      const made = withSearch(outcome);
      const calls: Array<{ rendered: string; question: string; history: unknown[] }> = [];
      made.deps.answerPortfolioFn = async (rendered, question, history) => {
        calls.push({ rendered, question, history: [...history] });
        return { text: `portfólio: ${question}`, model: 'm', usage };
      };
      return { ...made, calls };
    }

    // Spec §11.2 supersedes §10.4's cold-start-only gate: vocabulary names stay on the context, real names switch.
    describe('loose bare-name shapes vs a stored portfolio: vocabulary stays, real names switch (spec §11.2)', () => {
      const LOOSE = ['como estão os bloqueados?', 'qual o status dos pendentes?', 'como anda o resto?'];

      it.each(LOOSE)('unbound + portfolio stored: %s reaches Claude-over-portfolio, never a search', async (q) => {
        const { deps, searched, calls } = portfolioDeps();
        await handleMessage(dm('buscar norte'), deps);
        expect(searched).toEqual(['norte']);
        const replies = await handleMessage(dm(q), deps);
        expect(searched).toEqual(['norte']); // no second search
        expect(calls).toHaveLength(1);
        expect(calls[0].question).toBe(q);
        expect(replies[0].kind).toBe('card');
      });

      it('an assignee in the set is vocabulary: "como está o João?" stays on the context (§11.2)', async () => {
        const withJoao = cardsOutcome([{ ...jiraCard('AGL-11', 'Reforma do telhado'), assignee: 'João Silva' }]);
        const { deps, searched, calls } = portfolioDeps(withJoao);
        await handleMessage(dm('buscar norte'), deps);
        await handleMessage(dm('como está o João?'), deps);
        expect(searched).toEqual(['norte']);
        expect(calls[0].question).toBe('como está o João?');
      });

      it('with NO set stored the loose shape still searches (cold-start "qual o status da dalle?")', async () => {
        const { deps, searched, calls } = portfolioDeps();
        await handleMessage(dm('qual o status da dalle?'), deps);
        expect(searched).toEqual(['dalle']);
        expect(calls).toHaveLength(0);
      });

      it('an ANCHORED shape still switches context with a set stored', async () => {
        const { deps, searched, calls } = portfolioDeps();
        await handleMessage(dm('buscar norte'), deps);
        await handleMessage(dm('como estao as atividades da dalle?'), deps);
        expect(searched).toEqual(['norte', 'dalle']);
        expect(calls).toHaveLength(0);
      });
    });

    it('aggregates are computed at store time: two turns at different now() render byte-identical context (prompt cache, spec §2)', async () => {
      const collected = Date.parse('2026-09-30T12:00:00.000Z');
      // One hour short of stale at collection time; past the threshold by the second turn's now().
      const nearStale: CardCandidate = {
        ...jiraCard('AGL-11', 'Reforma'), updatedAt: new Date(collected - STALE_AFTER_DAYS * DAY_MS + 3_600_000).toISOString(),
      };
      const { deps, calls, setNow } = portfolioDeps(cardsOutcome([nearStale]));
      setNow(collected);
      await handleMessage(dm('buscar norte'), deps);
      await handleMessage(dm('qual é a mais antiga?'), deps);
      setNow(collected + 2 * 3_600_000);
      await handleMessage(dm('e a mais recente?'), deps);
      expect(calls).toHaveLength(2);
      expect(calls[1].rendered).toBe(calls[0].rendered);
      expect(calls[0].rendered).not.toContain('paradas há mais de');
    });

    it('counts follow-up reply carries the coletado às footer from the set', async () => {
      const { deps } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const text = textOf((await handleMessage(dm('quantos?'), deps))[0]);
      expect(text).toMatch(/\n\n— norte · coletado às \d{2}:\d{2}$/);
    });

    describe('portfolio and bound card coexist (spec §2/§3/§8)', () => {
      it('with a set AND a card bound, free-form text goes to the bound card', async () => {
        const { deps, answered, calls } = portfolioDeps();
        await handleMessage(dm('buscar norte'), deps);
        await handleMessage(dm('QZ-252'), deps); // bind AFTER the set: the set must survive
        const replies = await handleMessage(dm('quem é o responsável?'), deps);
        expect(answered.at(-1)).toBe('quem é o responsável?');
        expect(textOf(replies[0])).toContain('resposta para: quem é o responsável?');
        expect(calls).toHaveLength(0);
      });

      it('"quantos abertos?" still answers from the portfolio after a bind', async () => {
        const { deps, answered, calls } = portfolioDeps();
        await handleMessage(dm('buscar norte'), deps);
        await handleMessage(dm('QZ-252'), deps);
        const asked = answered.length;
        const replies = await handleMessage(dm('quantos abertos?'), deps);
        expect(textOf(replies[0])).toContain('2 abertos');
        expect(answered).toHaveLength(asked);
        expect(calls).toHaveLength(0);
      });

      it('"todos os de jira" renders the expand card after a bind', async () => {
        const { deps, answered } = portfolioDeps();
        await handleMessage(dm('buscar norte'), deps);
        await handleMessage(dm('QZ-252'), deps);
        const asked = answered.length;
        const replies = await handleMessage(dm('todos os de jira'), deps);
        expect(replies[0].kind).toBe('card');
        expect(textOf(replies[0])).toContain('AGL-11');
        expect(answered).toHaveLength(asked);
      });

      it('typed EXACT labels still rebind with a set stored and a card bound', async () => {
        const { deps, loaded } = portfolioDeps();
        await handleMessage(dm('QZ-252'), deps);
        await handleMessage(dm('buscar norte'), deps);
        await handleMessage(dm('AGL-12'), deps);
        expect(loaded.at(-1)).toEqual({ system: 'jira', issueKey: 'AGL-12', explicit: true });
        expect(((await deps.store.get(shared))?.ref as { issueKey: string }).issueKey).toBe('AGL-12');
        expect(await deps.candidates.get(shared)).toBeDefined();
      });
    });

    it('counts follow-up with a card bound answers from aggregates, without Claude', async () => {
      const { deps, answered, calls } = portfolioDeps();
      await handleMessage(dm('QZ-252'), deps);
      await handleMessage(dm('buscar norte'), deps);
      const asked = answered.length;
      const replies = await handleMessage(dm('quantos?'), deps);
      expect(replies).toHaveLength(1);
      expect(replies[0].kind).toBe('text');
      expect(textOf(replies[0])).toContain('2 atividades abertas');
      expect(textOf(replies[0])).toContain('por status (Jira): Em Teste: 2');
      expect(answered).toHaveLength(asked);
      expect(calls).toHaveLength(0);
    });

    it('counts follow-up with a status word leads with that status', async () => {
      const { deps } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      expect(textOf((await handleMessage(dm('quantos abertos'), deps))[0])).toContain('2 abertos');
    });

    it('a normal question with a card bound reaches answerFn even though a portfolio exists', async () => {
      const { deps, answered, calls } = portfolioDeps();
      await handleMessage(dm('QZ-252'), deps);
      await handleMessage(dm('buscar norte'), deps);
      const replies = await handleMessage(dm('qual o status atual?'), deps);
      expect(answered.at(-1)).toBe('qual o status atual?');
      expect(textOf(replies[0])).toContain('resposta para: qual o status atual?');
      expect(calls).toHaveLength(0);
    });

    it('a long "quantos ..." question with a card bound reaches answerFn, not the counts follow-up', async () => {
      const { deps, answered, calls } = portfolioDeps();
      await handleMessage(dm('QZ-252'), deps);
      await handleMessage(dm('buscar norte'), deps);
      const q = 'quantos casos de teste passaram?';
      const replies = await handleMessage(dm(q), deps);
      expect(answered.at(-1)).toBe(q);
      expect(textOf(replies[0])).toContain(`resposta para: ${q}`);
      expect(calls).toHaveLength(0);
    });

    it('unbound + portfolio + named entity searches (context switch) and the NEW set has empty history', async () => {
      const { deps, searched, calls } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const seeded = await deps.candidates.get(shared);
      await deps.candidates.set(shared, { ...seeded!, history: turn(1) });
      expect((await deps.candidates.get(shared))?.history).toHaveLength(2); // seed took

      const replies = await handleMessage(dm('status da empresa Norte'), deps);
      expect(searched).toEqual(['norte', 'Norte']);
      expect(calls).toHaveLength(0);
      expect(replies[0].kind).toBe('card');
      expect((await deps.candidates.get(shared))?.history).toEqual([]);
    });

    it('unbound + portfolio + free-form calls answerPortfolioFn with [estatísticas] and [atividades] context', async () => {
      const { deps, calls } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const replies = await handleMessage(dm('qual é a mais antiga?'), deps);
      expect(calls).toHaveLength(1);
      expect(calls[0].question).toBe('qual é a mais antiga?');
      expect(calls[0].rendered).toContain('[estatísticas]');
      expect(calls[0].rendered).toContain('[atividades]');
      expect(calls[0].rendered).toContain('AGL-11');
      const reply = replies[0];
      if (reply.kind !== 'card') throw new Error('unreachable');
      expect(reply.fallbackText).toContain('portfólio: qual é a mais antiga?');
      expect(reply.fallbackText).toContain('coletado às');
      expect(JSON.stringify(reply.card)).toContain('norte');
    });

    it('persists portfolio history onto the set, sliced to MAX_HISTORY_TURNS', async () => {
      const { deps, calls } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const seeded = (await deps.candidates.get(shared))!;
      const old = Array.from({ length: MAX_HISTORY_TURNS + 2 }, (_, i) => turn(i)).flat().slice(0, MAX_HISTORY_TURNS + 2);
      await deps.candidates.set(shared, { ...seeded, history: old });

      await handleMessage(dm('qual é a mais antiga?'), deps);
      expect(calls[0].history).toEqual(old);
      const stored = (await deps.candidates.get(shared))!.history;
      expect(stored).toHaveLength(MAX_HISTORY_TURNS);
      expect(stored.at(-2)).toEqual({ role: 'user', text: 'qual é a mais antiga?' });
      expect(stored.at(-1)).toEqual({ role: 'assistant', text: 'portfólio: qual é a mais antiga?' });
    });

    it('answerPortfolioFn throwing replies CLAUDE_UNAVAILABLE and leaves history untouched', async () => {
      const { deps } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      deps.answerPortfolioFn = async () => { throw new Error('429 rate limit'); };
      const replies = await handleMessage(dm('qual é a mais antiga?'), deps);
      expect(replies).toHaveLength(1);
      expect(textOf(replies[0])).toBe(CLAUDE_UNAVAILABLE);
      expect((await deps.candidates.get(shared))?.history).toEqual([]);
    });

    it('expand renders the requested section uncapped (more candidates than SECTION_LINE_CAP)', async () => {
      const many = Array.from({ length: SECTION_LINE_CAP + 3 }, (_, i) => jiraCard(`AGL-${100 + i}`, `Tarefa ${i}`));
      const { deps } = portfolioDeps(cardsOutcome(many));
      const first = (await handleMessage(dm('buscar norte'), deps))[0];
      expect(textOf(first)).toContain('AGL-100');

      const replies = await handleMessage(dm('todos os de jira'), deps);
      expect(replies).toHaveLength(1);
      const reply = replies[0];
      if (reply.kind !== 'card') throw new Error('unreachable');
      for (const c of many) {
        expect(reply.fallbackText).toContain(c.label);
        expect(JSON.stringify(reply.card)).toContain(c.label);
      }
      expect(reply.fallbackText).not.toContain('e mais');
    });

    it('skips the history write when the set was replaced or cleared during the Claude call', async () => {
      const { deps } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const replacement = { ...(await deps.candidates.get(shared))!, name: 'OUTRA', createdAt: T0 + 5 };
      deps.answerPortfolioFn = async () => {
        await deps.candidates.set(shared, replacement); // a search landed mid-call
        return { text: 'r', model: 'm', usage };
      };
      const replies = await handleMessage(dm('qual é a mais antiga?'), deps);
      expect(textOf(replies[0])).toContain('r');
      expect(await deps.candidates.get(shared)).toEqual(replacement); // not resurrected/clobbered

      deps.answerPortfolioFn = async () => {
        await deps.candidates.delete(shared); // a selection cleared it
        return { text: 'r2', model: 'm', usage };
      };
      await handleMessage(dm('outra pergunta?'), deps);
      expect(await deps.candidates.get(shared)).toBeUndefined();
    });

    it('history keeps the RAW answer; card body and fallbackText carry compressed citations', async () => {
      const { deps } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const raw = 'veja [comentário jira 41713] [estatísticas]';
      deps.answerPortfolioFn = async () => ({ text: raw, model: 'm', usage });
      const reply = (await handleMessage(dm('qual é a mais antiga?'), deps))[0];
      if (reply.kind !== 'card') throw new Error('unreachable');
      const stored = (await deps.candidates.get(shared))!.history;
      expect(stored.at(-1)).toEqual({ role: 'assistant', text: raw });
      expect(reply.fallbackText).toContain('[jira 41713]');
      // Flipped by spec §13: the display strips [estatísticas]; history (asserted raw above) keeps it.
      expect(reply.fallbackText).not.toContain('[estatísticas]');
      expect(reply.fallbackText).not.toContain('comentário jira');
      const body = JSON.stringify(reply.card);
      expect(body).toContain('[jira 41713]');
      expect(body).not.toContain('[estatísticas]');
      expect(body).not.toContain('comentário jira');
    });

    it('spec §14: the card body and fallback are styled (bold link, bold status); history keeps the raw answer', async () => {
      const { deps } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const raw = 'O [AGL-11] está Em Teste.';
      deps.answerPortfolioFn = async () => ({ text: raw, model: 'm', usage });
      const reply = (await handleMessage(dm('e o telhado?'), deps))[0];
      if (reply.kind !== 'card') throw new Error('unreachable');
      const link = '**[AGL-11](https://your-tenant.atlassian.net/browse/AGL-11)**';
      expect(reply.fallbackText).toContain(`O ${link} está **Em Teste**.`);
      expect(JSON.stringify(reply.card)).toContain(`O ${link} está **Em Teste**.`);
      expect((await deps.candidates.get(shared))!.history.at(-1)).toEqual({ role: 'assistant', text: raw });
    });

    it('"todos os de zendesk" and "mostra tudo" expand; the OTHER section stays capped', async () => {
      const jira = Array.from({ length: SECTION_LINE_CAP + 2 }, (_, i) => jiraCard(`AGL-${100 + i}`, `J${i}`));
      const zen = Array.from({ length: SECTION_LINE_CAP + 2 }, (_, i): CardCandidate => ({
        ref: { system: 'zendesk', ticketId: `${500 + i}`, explicit: true },
        label: `chamado ${500 + i}`, summary: `Z${i}`, status: 'open', updatedAt: '2026-09-20T10:00:00.000Z',
      }));
      const { deps } = portfolioDeps(cardsOutcome([...jira, ...zen]));
      await handleMessage(dm('buscar norte'), deps);

      const z = (await handleMessage(dm('todos os de zendesk'), deps))[0];
      if (z.kind !== 'card') throw new Error('unreachable');
      for (const c of zen) expect(z.fallbackText).toContain(c.label);
      expect(z.fallbackText).toContain(jira[0].label);
      expect(z.fallbackText).toContain('e mais 2'); // jira section still capped

      const all = (await handleMessage(dm('mostra tudo'), deps))[0];
      for (const c of [...jira, ...zen]) expect(textOf(all)).toContain(c.label);
      expect(textOf(all)).not.toContain('e mais');
    });

    it('filler-prefixed "quero ver todos os de zendesk" expands deterministically, no Claude', async () => {
      const { deps, calls } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const r = (await handleMessage(dm('quero ver todos os de zendesk'), deps))[0];
      expect(r.kind).toBe('card');
      expect(calls).toHaveLength(0);
    });

    it('distribution follow-ups reply with one card (status sections / assignee lines), no Claude', async () => {
      const { deps, calls } = portfolioDeps();
      await handleMessage(dm('buscar norte'), deps);
      const s = (await handleMessage(dm('me mostra por status'), deps))[0];
      if (s.kind !== 'card') throw new Error('unreachable');
      expect(JSON.stringify(s.card)).toContain('**Em Teste — 2:**');
      expect(JSON.stringify(s.card)).toContain('Cards (Jira)');
      expect(s.fallbackText).toContain('**Em Teste — 2:**');
      const a = (await handleMessage(dm('divide por responsável'), deps))[0];
      if (a.kind !== 'card') throw new Error('unreachable');
      expect(JSON.stringify(a.card)).toContain('**sem responsável — 2:**');
      expect(calls).toHaveLength(0);
    });

    it('unbound + no portfolio + free-form is still NOTHING_BOUND, and never calls Claude', async () => {
      const { deps, calls } = portfolioDeps();
      const replies = await handleMessage(dm('qual é a mais antiga?'), deps);
      expect(textOf(replies[0])).toBe(NOTHING_BOUND);
      expect(calls).toHaveLength(0);
    });

    it('bare "quantos" with no portfolio falls through to the normal pipeline (no crash)', async () => {
      const { deps, calls } = portfolioDeps();
      const unbound = await handleMessage(dm('quantos'), deps);
      expect(textOf(unbound[0])).toBe(NOTHING_BOUND);
      await handleMessage(dm('QZ-252'), deps);
      const bound = await handleMessage(dm('quantos'), deps);
      expect(textOf(bound[0])).toContain('resposta para: quantos');
      expect(calls).toHaveLength(0);
    });
  });
});

// Spec §11: confirm-to-switch while a card is bound.
describe('confirm-to-switch while bound (spec §11)', () => {
  const jiraCard = (key: string, summary: string): CardCandidate => ({
    ref: { system: 'jira', issueKey: key, explicit: true },
    label: key, summary, status: 'Em Teste', updatedAt: '2026-09-20T10:00:00.000Z',
  });
  const outcome: SearchOutcome = {
    kind: 'cards', name: 'dalle', displayName: 'DALLE', total: 1, cards: [jiraCard('AGL-11', 'Reforma')],
  };
  const req = { conversationId: CONV, conversationType: 'personal', userId: 'u' };
  const shared = { scope: 'shared' as const, conversationId: CONV };

  function bound() {
    const searched: string[] = [];
    const made = makeDeps({ search: async (name) => { searched.push(name); return outcome; } });
    return { ...made, searched };
  }
  const actions = (r: Reply) => (r.kind === 'card' ? (r.card.actions as Array<Record<string, any>>) : []);

  it('an anchored portfolio question while bound yields a confirm card: no Claude call, no search', async () => {
    const { deps, answered, searched } = bound();
    await handleMessage(dm('QZ-252'), deps);
    const before = answered.length;
    const replies = await handleMessage(dm('como estao as atividades da dalle?'), deps);
    expect(replies).toHaveLength(1);
    expect(replies[0].kind).toBe('card');
    expect(answered.length).toBe(before);
    expect(searched).toEqual([]);
    const [buscar, continuar] = actions(replies[0]);
    expect(buscar.verb).toBe(BUSCAR_ACTION);
    expect(buscar.title).toBe('Buscar dalle');
    // §11.2: the payload also carries the detected mode (plural-anchor shapes are rundowns).
    expect(buscar.data).toEqual({ action: BUSCAR_ACTION, name: 'dalle', mode: 'rundown' });
    expect(continuar.verb).toBe(CONTINUAR_ACTION);
    expect(continuar.title).toBe('Continuar no QZ-252');
    expect(continuar.data).toEqual({ action: CONTINUAR_ACTION, text: 'como estao as atividades da dalle?' });
    expect(textOf(replies[0])).toContain('Você quer ver as atividades de **dalle**?');
    expect(textOf(replies[0])).toContain('QZ-252');
  });

  it('the Buscar button runs the typed-buscar search; spec §11.2 flips "binding stays intact" to unbound', async () => {
    const { deps, searched } = bound();
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleSwitchBuscar(req, { action: BUSCAR_ACTION, name: 'dalle' }, deps);
    expect(searched).toEqual(['dalle']);
    expect(replies).toHaveLength(1);
    expect(textOf(replies[0])).toContain('atividades abertas');
    expect(await deps.store.get(shared)).toBeUndefined();
  });

  it('the Continuar button sends the ORIGINAL text to the bound card answer path', async () => {
    const { deps, answered } = bound();
    await handleMessage(dm('QZ-252'), deps);
    const q = 'como estao as atividades da dalle?';
    const replies = await handleSwitchContinuar(req, { action: CONTINUAR_ACTION, text: q }, deps);
    expect(answered.at(-1)).toBe(q);
    expect(replies).toHaveLength(1);
    expect(textOf(replies[0])).toContain(`resposta para: ${q}`);
    expect(textOf(replies[0])).toContain('coletado às');
  });

  it('a genuine question with no entity anchor goes straight to the bound card (regression pin)', async () => {
    const { deps, answered, searched } = bound();
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('qual o prazo de entrega?'), deps);
    expect(answered.at(-1)).toBe('qual o prazo de entrega?');
    expect(searched).toEqual([]);
    expect(textOf(replies[0])).toContain('resposta para:');
  });

  it('a mid-sentence anchor DOES show the confirm card (spec §11 accepts this false positive)', async () => {
    const { deps, answered } = bound();
    await handleMessage(dm('QZ-252'), deps);
    const before = answered.length;
    const replies = await handleMessage(dm('o problema da obra Flora persiste?'), deps);
    expect(answered.length).toBe(before);
    expect(actions(replies[0]).map((a) => a.verb)).toEqual([BUSCAR_ACTION, CONTINUAR_ACTION]);
  });

  // Flipped by spec §11.1: the round-1 pin ("loose shapes never fire while bound") is superseded;
  // loose shapes now raise the confirm card, and generic tails stay on the bound card.
  it.each(['Qual o status da Flora?', 'quero saber sobre a Flora', 'como está a dalle?'])(
    'loose shape while bound raises the confirm card (§11.1): %s',
    async (q) => {
      const { deps, answered, searched } = bound();
      await handleMessage(dm('QZ-252'), deps);
      const before = answered.length;
      const replies = await handleMessage(dm(q), deps);
      expect(answered.length).toBe(before);
      expect(searched).toEqual([]);
      expect(actions(replies[0]).map((a) => a.verb)).toEqual([BUSCAR_ACTION, CONTINUAR_ACTION]);
      expect(actions(replies[0])[1].data).toEqual({ action: CONTINUAR_ACTION, text: q });
    },
  );

  it.each([
    'qual o status do chamado?', 'como está a obra?', 'qual o prazo de entrega?', 'não quero saber sobre a Flora',
    'quero saber sobre o que aconteceu', 'como estão os comentários?',
  ])('no interstitial while bound (§11.1 guards): %s', async (q) => {
    const { deps, answered, searched } = bound();
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm(q), deps);
    expect(answered.at(-1)).toBe(q);
    expect(searched).toEqual([]);
    expect(textOf(replies[0])).toContain('resposta para:');
  });

  it('unbound cold start: a generic tail ("qual o status do card?") no longer searches (§11.1)', async () => {
    const { deps, searched } = bound();
    const replies = await handleMessage(dm('qual o status do card?'), deps);
    expect(searched).toEqual([]);
    expect(textOf(replies[0])).toBe(NOTHING_BOUND);
  });

  it('unbound cold start: a real name still searches', async () => {
    const { deps, searched } = bound();
    await handleMessage(dm('qual o status da dalle?'), deps);
    expect(searched).toEqual(['dalle']);
  });

  it('precedence: typed buscar still wins over the confirm card while bound', async () => {
    const { deps, searched } = bound();
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('buscar atividades da dalle'), deps);
    expect(searched).toEqual(['atividades da dalle']);
    expect(textOf(replies[0])).toContain('atividades abertas');
  });

  it('malformed confirm payloads get a pt-BR invalid reply, never silence', async () => {
    const { deps } = bound();
    for (const bad of [undefined, null, 'x', {}, { name: '' }, { name: '  ' }, { name: 5 }]) {
      expect(await handleSwitchBuscar(req, bad, deps)).toEqual([{ kind: 'text', text: SELECTION_INVALID }]);
    }
    for (const bad of [undefined, null, 'x', {}, { text: '' }, { text: 7 }]) {
      expect(await handleSwitchContinuar(req, bad, deps)).toEqual([{ kind: 'text', text: SELECTION_INVALID }]);
    }
  });

  it('Continuar with nothing bound (binding expired) still replies', async () => {
    const { deps } = bound();
    const r = await handleSwitchContinuar(req, { text: 'como estao as atividades da dalle?' }, deps);
    expect(r).toEqual([{ kind: 'text', text: NOTHING_BOUND }]);
  });
});

describe('HELP_TEXT rendering (spec §12)', () => {
  it('has no angle brackets (Teams renders them as &lt;&gt;)', () => {
    expect(HELP_TEXT).not.toMatch(/[<>]/);
  });
  it('keeps a concrete buscar example', () => {
    expect(HELP_TEXT).toContain('`buscar`');
    expect(HELP_TEXT).toContain('(ex.: `buscar dalle`)');
  });
  it('separates each command line with a blank line so Teams renders them on their own lines', () => {
    for (const c of ['`ajuda`', '`atualizar`', '`buscar`', '`quantos?`', '`voltar`']) {
      expect(HELP_TEXT).toContain(`\n\n${c}`);
    }
  });
});

// Spec §11.2 / §13.
describe('move-on semantics and vocabulary-aware switching (spec §11.2)', () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const mk = (key: string, assignee?: string): CardCandidate => ({
    ref: { system: 'jira', issueKey: key, explicit: true },
    label: key, summary: 'Reforma', status: 'Bloqueado', updatedAt: '2026-09-20T10:00:00.000Z',
    ...(assignee ? { assignee } : {}),
  });
  const req = { conversationId: CONV, conversationType: 'personal', userId: 'u' };
  const shared = { scope: 'shared' as const, conversationId: CONV };

  function world(assignee = 'João Silva') {
    const searched: string[] = [];
    const calls: string[] = [];
    const made = makeDeps({
      search: async (name) => {
        searched.push(name);
        return { kind: 'cards', name, displayName: name.toUpperCase(), total: 2, cards: [mk('AGL-11', assignee), mk('AGL-12')] };
      },
      answerPortfolioFn: async (_r, q) => { calls.push(q); return { text: `portfólio: ${q}`, model: 'm', usage }; },
    });
    return { ...made, searched, calls };
  }
  const verbs = (r: Reply) => (r.kind === 'card' ? (r.card.actions as Array<Record<string, any>> | undefined) ?? [] : []).map((a) => a.verb);

  it('Buscar click unbinds the card, runs the search in the detected mode, stores the context', async () => {
    const { deps, answered, searched } = world();
    await handleMessage(dm('QZ-252'), deps);
    const confirm = await handleMessage(dm('como esta jardins de potengi?'), deps);
    const buscar = (confirm[0] as any).card.actions[0];
    expect(buscar.data).toEqual({ action: BUSCAR_ACTION, name: 'jardins de potengi', mode: 'rundown' });
    const replies = await handleSwitchBuscar(req, buscar.data, deps);
    expect(searched).toEqual(['jardins de potengi']);
    expect(verbs(replies[0])).toEqual([]); // rundown card: no select buttons
    expect(await deps.store.get(shared)).toBeUndefined();
    expect((await deps.candidates.get(shared))?.name).toBe('JARDINS DE POTENGI');
    const before = answered.length;
    await handleMessage(dm('qual o prazo de entrega?'), deps);
    expect(answered.length).toBe(before); // not answered by the old card
  });

  it('typed buscar keeps candidates mode (select buttons) and does not unbind', async () => {
    const { deps } = world();
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('buscar dalle'), deps);
    expect(verbs(replies[0]).length).toBeGreaterThan(0);
    expect(await deps.store.get(shared)).toBeDefined();
  });

  it('Buscar click with a missing mode falls back to candidates; an invalid mode is rejected', async () => {
    const { deps } = world();
    const ok = await handleSwitchBuscar(req, { name: 'dalle' }, deps);
    expect(verbs(ok[0]).length).toBeGreaterThan(0);
    expect(await handleSwitchBuscar(req, { name: 'dalle', mode: 'x' }, deps)).toEqual([{ kind: 'text', text: SELECTION_INVALID }]);
  });

  it('a failed search on the Buscar click does not cost the user the binding', async () => {
    const { deps } = world();
    await handleMessage(dm('QZ-252'), deps);
    deps.search = async () => { throw new Error('x'); };
    const replies = await handleSwitchBuscar(req, { name: 'dalle', mode: 'rundown' }, deps);
    expect(textOf(replies[0])).toBe(SEARCH_UNAVAILABLE);
    expect(await deps.store.get(shared)).toBeDefined();
  });

  describe('Buscar click failure semantics: an error never leaves the user with nothing bound (spec §11.2)', () => {
    const bindOne: SearchOutcome = {
      kind: 'bind', displayName: 'DALLE',
      candidate: { ...mk('AGL-11'), ref: { system: 'jira', issueKey: 'AGL-11', explicit: true } },
    };
    async function boundWorld() {
      const w = world();
      await handleMessage(dm('QZ-252'), w.deps);
      const original = await w.deps.store.get(shared);
      w.deps.search = async () => bindOne;
      return { ...w, original };
    }

    it('single-match bind whose bundle load THROWS restores the original binding', async () => {
      const { deps, original } = await boundWorld();
      deps.loadBundle = async () => { throw new Error('boom'); };
      const replies = await handleSwitchBuscar(req, { name: 'dalle', mode: 'rundown' }, deps);
      expect(textOf(replies[0])).toBe(JIRA_UNAVAILABLE);
      expect(await deps.store.get(shared)).toEqual(original);
    });

    it('single-match bind that is not_found restores the original binding', async () => {
      const { deps, original } = await boundWorld();
      deps.loadBundle = async () => ({ status: 'not_found', message: 'Card não encontrado.' }) as AssembleResult;
      const replies = await handleSwitchBuscar(req, { name: 'dalle', mode: 'rundown' }, deps);
      expect(textOf(replies[0])).toBe('Card não encontrado.');
      expect(await deps.store.get(shared)).toEqual(original);
    });

    it('a successful single-match bind replaces the old card (no restore)', async () => {
      const { deps } = await boundWorld();
      await handleSwitchBuscar(req, { name: 'dalle', mode: 'rundown' }, deps);
      expect((await deps.store.get(shared))?.ref).toMatchObject({ issueKey: 'AGL-11' });
    });

    it('a search that throws restores the original binding', async () => {
      const { deps, original } = await boundWorld();
      deps.search = async () => { throw new Error('x'); };
      await handleSwitchBuscar(req, { name: 'dalle', mode: 'rundown' }, deps);
      expect(await deps.store.get(shared)).toEqual(original);
    });

    it('an unexpected throw after the unbind restores the binding, then rethrows', async () => {
      const { deps, original } = await boundWorld();
      deps.search = async () => ({ kind: 'cards', name: 'd', displayName: 'D', total: 1, cards: [mk('AGL-12')] });
      deps.candidates.set = async () => { throw new Error('store down'); };
      await expect(handleSwitchBuscar(req, { name: 'dalle', mode: 'rundown' }, deps)).rejects.toThrow('store down');
      expect(await deps.store.get(shared)).toEqual(original);
    });

    it('none and orgs intentionally leave the user unbound', async () => {
      const { deps } = await boundWorld();
      deps.search = async () => ({ kind: 'none', name: 'dalle' });
      await handleSwitchBuscar(req, { name: 'dalle', mode: 'rundown' }, deps);
      expect(await deps.store.get(shared)).toBeUndefined();
    });

    it('thread: a personal split is the slot unbound and restored; the shared card is untouched', async () => {
      const { deps } = world();
      await handleMessage({ ...ana, text: 'QZ-252' }, deps);
      await handleMessage({ ...ana, text: 'AGL-900 qual o status?' }, deps);
      const personal = { scope: 'personal' as const, conversationId: 'thread', userId: 'ana' };
      const threadShared = { scope: 'shared' as const, conversationId: 'thread' };
      const originalPersonal = await deps.store.get(personal);
      const originalShared = await deps.store.get(threadShared);
      deps.search = async () => { throw new Error('x'); };
      await handleSwitchBuscar(ana, { name: 'dalle', mode: 'rundown' }, deps);
      expect(await deps.store.get(personal)).toEqual(originalPersonal);
      expect(await deps.store.get(threadShared)).toEqual(originalShared);
      // On success only the personal split goes. The surviving shared card is the room's and may
      // re-raise the interstitial on the next matching message (accepted by spec §11.2).
      deps.search = async () => ({ kind: 'cards', name: 'd', displayName: 'D', total: 1, cards: [mk('AGL-12')] });
      await handleSwitchBuscar(ana, { name: 'dalle', mode: 'rundown' }, deps);
      expect(await deps.store.get(personal)).toBeUndefined();
      expect(await deps.store.get(threadShared)).toEqual(originalShared);
    });
  });

  it('an ANCHORED name colliding with portfolio vocabulary still switches (anchored bypasses the filter)', async () => {
    const { deps, searched, calls } = world('Dalle X');
    await handleMessage(dm('buscar flora'), deps);
    await handleMessage(dm('como estao as atividades da dalle?'), deps);
    expect(searched).toEqual(['flora', 'dalle']);
    await handleMessage(dm('como está a dalle?'), deps); // loose + vocabulary: stays on the context
    expect(searched).toEqual(['flora', 'dalle']);
    expect(calls).toHaveLength(1);
  });

  describe('unbound with a portfolio stored', () => {
    it('a real name switches (context replaced)', async () => {
      const { deps, searched, calls } = world();
      await handleMessage(dm('buscar flora'), deps);
      await handleMessage(dm('como esta jardins de potengi?'), deps);
      expect(searched).toEqual(['flora', 'jardins de potengi']);
      expect(calls).toEqual([]);
    });
    it.each(['como estão os bloqueados?', 'como está o João?', 'como está o Bloqueado?'])(
      'vocabulary name stays on the context (Claude-over-portfolio): %s',
      async (q) => {
        const { deps, searched, calls } = world();
        await handleMessage(dm('buscar flora'), deps);
        await handleMessage(dm(q), deps);
        expect(searched).toEqual(['flora']);
        expect(calls).toEqual([q]);
      },
    );
    it('cold start still searches', async () => {
      const { deps, searched } = world();
      await handleMessage(dm('qual o status da dalle?'), deps);
      expect(searched).toEqual(['dalle']);
    });
  });

  describe('bound with a portfolio stored', () => {
    async function bound() {
      const w = world();
      await handleMessage(dm('buscar flora'), w.deps);
      await handleMessage(dm('QZ-252'), w.deps);
      return w;
    }
    it('a real name raises the confirm card', async () => {
      const { deps, answered } = await bound();
      const before = answered.length;
      const replies = await handleMessage(dm('como esta jardins de potengi?'), deps);
      expect(answered.length).toBe(before);
      expect(verbs(replies[0])).toEqual([BUSCAR_ACTION, CONTINUAR_ACTION]);
    });
    it.each(['como estão os bloqueados?', 'como está o João?'])(
      'vocabulary name goes straight to the bound card, no interstitial: %s',
      async (q) => {
        const { deps, answered } = await bound();
        await handleMessage(dm(q), deps);
        expect(answered.at(-1)).toBe(q);
      },
    );
    it('an anchored shape still raises the confirm card', async () => {
      const { deps } = await bound();
      const replies = await handleMessage(dm('como estao as atividades da dalle?'), deps);
      expect(verbs(replies[0])).toEqual([BUSCAR_ACTION, CONTINUAR_ACTION]);
    });
  });

  it('organize/agrupa distribution verbs render the card while bound with a set (step 1c), no Claude', async () => {
    const { deps, answered } = world();
    await handleMessage(dm('buscar flora'), deps);
    await handleMessage(dm('QZ-252'), deps);
    const before = answered.length;
    const byStatus = await handleMessage(dm('organize por status'), deps);
    expect(byStatus[0].kind).toBe('card');
    expect(textOf(byStatus[0])).toContain('Cards (Jira)');
    expect(textOf(byStatus[0])).toContain('Bloqueado — 2');
    const byAssignee = await handleMessage(dm('agrupa por responsável'), deps);
    expect(byAssignee[0].kind).toBe('card');
    expect(textOf(byAssignee[0])).toContain('João Silva — 1');
    expect(answered.length).toBe(before);
  });
});

describe('lembrar responsável (reminder spec §3-§5)', () => {
  const joao: DirectoryUser = { id: 'g1', displayName: 'João Silva', mail: 'joao@org.com' };
  const joao2: DirectoryUser = { id: 'g2', displayName: 'João Silva', mail: null };

  function assigneeBundle(assignee: unknown): CardBundle {
    const base = bundleFor('QZ-252');
    return { ...base, jira: { ...base.jira!, fields: { summary: 'Erro no relatório', assignee } } } as CardBundle;
  }

  /** A DM bound to QZ-252 whose Jira assignee is `assignee`, with a spied directory. */
  async function bound(assignee: unknown, users: DirectoryUser[] | Error) {
    const searchByName = vi.fn(async (_q: string) => {
      if (users instanceof Error) throw users;
      return users;
    });
    const made = makeDeps({
      loadBundle: async () => ({ status: 'ok', bundle: assigneeBundle(assignee) } as AssembleResult),
      directory: { searchByName },
    });
    await handleMessage(dm('QZ-252'), made.deps);
    return { ...made, searchByName };
  }

  const joaoAssignee = { displayName: 'João Silva' };

  it('without a card explains how to start', async () => {
    const { deps } = makeDeps();
    const replies = await handleMessage(dm('lembrar responsável'), deps);
    expect(replies).toEqual([{ kind: 'text', text: REMINDER_NEEDS_CARD }]);
  });

  it('an over-long note answers NOTE_TOO_LONG, no directory call', async () => {
    const { deps, searchByName } = await bound(joaoAssignee, [joao]);
    const replies = await handleMessage(dm(`lembrar responsável: ${'x'.repeat(NOTE_MAX_CHARS + 1)}`), deps);
    expect(replies).toEqual([{ kind: 'text', text: NOTE_TOO_LONG }]);
    expect(searchByName).not.toHaveBeenCalled();
  });

  it('bound card without assignee answers NO_ASSIGNEE_REPLY, no directory call', async () => {
    const { deps, searchByName } = await bound(null, [joao]);
    const replies = await handleMessage(dm('lembrar responsável'), deps);
    expect(replies).toEqual([{ kind: 'text', text: NO_ASSIGNEE_REPLY }]);
    expect(searchByName).not.toHaveBeenCalled();
  });

  it('one directory match -> confirmation card with the note, nothing sent', async () => {
    const { deps, answered } = await bound(joaoAssignee, [joao]);
    const before = answered.length;
    const [reply] = await handleMessage(dm('lembrar responsável: reunião às 10h'), deps);
    expect(reply.kind).toBe('card');
    const card = JSON.stringify((reply as { card: unknown }).card);
    for (const s of [REMIND_SEND_ACTION, 'João Silva', 'joao@org.com', 'QZ-252', 'Erro no relatório', 'reunião às 10h']) {
      expect(card).toContain(s);
    }
    expect(textOf(reply)).toContain('Enviar lembrete para **João Silva**');
    expect(answered.length).toBe(before); // never reaches Claude
  });

  it('several matches -> pick card, one button per candidate', async () => {
    const { deps } = await bound(joaoAssignee, [joao, joao2]);
    const [reply] = await handleMessage(dm('lembrar responsável'), deps);
    expect(reply.kind).toBe('card');
    const card = (reply as unknown as { card: { actions: { verb: string }[] } }).card;
    expect(card.actions.filter((a) => a.verb === REMIND_PICK_ACTION)).toHaveLength(2);
    expect(textOf(reply)).toContain('sem e-mail');
  });

  it('zero matches -> NOT_IN_ORG with the assignee name', async () => {
    const { deps } = await bound(joaoAssignee, []);
    const replies = await handleMessage(dm('lembrar responsável'), deps);
    expect(replies).toEqual([{ kind: 'text', text: NOT_IN_ORG('João Silva') }]);
  });

  it('directory throwing -> DIRECTORY_UNAVAILABLE, no error text leaks', async () => {
    const { deps } = await bound(joaoAssignee, new Error('boom graph 500'));
    const replies = await handleMessage(dm('lembrar responsável'), deps);
    expect(replies).toEqual([{ kind: 'text', text: DIRECTORY_UNAVAILABLE }]);
  });

  it('deps.directory undefined -> unconfigured reply (spec §7)', async () => {
    const { deps } = makeDeps({
      loadBundle: async () => ({ status: 'ok', bundle: assigneeBundle(joaoAssignee) } as AssembleResult),
    });
    await handleMessage(dm('QZ-252'), deps);
    const replies = await handleMessage(dm('lembrar responsável'), deps);
    expect(replies).toEqual([{ kind: 'text', text: UNCONFIGURED_DIRECTORY }]);
    expect(UNCONFIGURED_DIRECTORY).toContain('indisponível neste ambiente');
  });

  it('a genuine question mentioning lembrar is NOT the command', async () => {
    const { deps, answered, searchByName } = await bound(joaoAssignee, [joao]);
    const replies = await handleMessage(dm('como faço para lembrar o responsável?'), deps);
    expect(answered).toContain('como faço para lembrar o responsável?');
    expect(searchByName).not.toHaveBeenCalled();
    expect(textOf(replies[0])).toContain('resposta para');
  });

  describe('handleReminderPick', () => {
    const conv = { conversationId: CONV, conversationType: 'personal', userId: 'u' };
    const pick = { action: REMIND_PICK_ACTION, userId: 'g2', userName: 'João Silva', userMail: null, cardKey: 'QZ-252', note: 'oi' };

    it('a pick answers with the same confirmation card for the picked user', async () => {
      const { deps } = await bound(joaoAssignee, [joao, joao2]);
      const [reply] = await handleReminderPick(conv, pick, deps);
      expect(reply.kind).toBe('card');
      const card = (reply as unknown as { card: { actions: { verb: string; data: Record<string, unknown> }[] } }).card;
      const send = card.actions.find((a) => a.verb === REMIND_SEND_ACTION);
      expect(send?.data).toMatchObject({ userId: 'g2', userMail: null, cardKey: 'QZ-252', note: 'oi' });
      expect(textOf(reply)).toContain('sem e-mail');
      expect(textOf(reply)).toContain('Erro no relatório');
    });

    it.each([
      ['a non-object', 'x'], ['null', null],
      ['a missing userId', { ...pick, userId: undefined }],
      ['a blank userName', { ...pick, userName: '  ' }],
      ['a numeric mail', { ...pick, userMail: 5 }],
      ['a numeric note', { ...pick, note: 5 }],
      ['a missing cardKey', { ...pick, cardKey: undefined }],
    ])('malformed payload (%s) -> SELECTION_INVALID', async (_n, data) => {
      const { deps } = await bound(joaoAssignee, [joao]);
      expect(await handleReminderPick(conv, data, deps)).toEqual([{ kind: 'text', text: SELECTION_INVALID }]);
    });

    it('nothing bound, or a different card bound -> REMINDER_EXPIRED', async () => {
      const { deps } = makeDeps();
      expect(await handleReminderPick(conv, pick, deps)).toEqual([{ kind: 'text', text: REMINDER_EXPIRED }]);
      const b = await bound(joaoAssignee, [joao]);
      const other = { ...pick, cardKey: 'QZ-999' };
      expect(await handleReminderPick(conv, other, b.deps)).toEqual([{ kind: 'text', text: REMINDER_EXPIRED }]);
    });
  });

  describe('handleReminderSend / handleReminderCancel', () => {
    const conv = { conversationId: CONV, conversationType: 'personal', userId: 'u' };
    const sendData = {
      action: REMIND_SEND_ACTION, userId: 'g1', userName: 'João Silva', userMail: 'joao@org.com', cardKey: 'QZ-252', note: 'reunião às 10h',
    };
    const STATUS = 'Em Teste';

    function statusBundle(assignee: unknown, status: string = STATUS): CardBundle {
      const base = assigneeBundle(assignee);
      return { ...base, jira: { ...base.jira!, fields: { ...base.jira!.fields, status: { name: status } } } } as CardBundle;
    }

    /** A bound DM with a recording sender; `bundles` is what each successive vendor load returns. */
    async function sendWorld(bundles: CardBundle[], sender?: ReminderSenderLike | null) {
      const sent: Array<{ userId: string; text: string }> = [];
      const fake: ReminderSenderLike = sender ?? { sendDm: async (userId, text) => { sent.push({ userId, text }); } };
      let loads = 0;
      const made = makeDeps({
        loadBundle: async () => ({ status: 'ok', bundle: bundles[Math.min(loads++, bundles.length - 1)] } as AssembleResult),
        ...(sender === null ? {} : { sendReminder: fake }),
      });
      await handleMessage(dm('QZ-252'), made.deps);
      return { ...made, sent, loadCount: () => loads };
    }

    const asker = { ...conv, userName: 'Andres' };

    it('Enviar sends ONE dm with the template text, replies REMINDER_SENT, logs one audit line without the text', async () => {
      const { deps, sent } = await sendWorld([statusBundle(joaoAssignee)]);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const replies = await handleReminderSend(asker, sendData, deps);
      const lines = log.mock.calls.map((c) => String(c[0]));
      log.mockRestore();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.userId).toBe('g1');
      for (const s of ['**Andres**', '[QZ-252](', 'Erro no relatório', STATUS, '> reunião às 10h']) expect(sent[0]!.text).toContain(s);
      expect(replies).toEqual([{ kind: 'text', text: REMINDER_SENT('João Silva') }]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Andres');
      expect(lines[0]).toContain('g1');
      expect(lines[0]).toContain('QZ-252');
      expect(lines[0]).toContain('sent');
      expect(lines[0]).not.toContain('reunião às 10h');
    });

    it('a fresh bundle is not refetched on Enviar (no vendor call)', async () => {
      const { deps, loadCount } = await sendWorld([statusBundle(joaoAssignee)]);
      const before = loadCount();
      await handleReminderSend(asker, sendData, deps);
      expect(loadCount()).toBe(before);
    });

    it('a stale bundle with the same assignee is refreshed: the DM carries the refreshed status', async () => {
      const w = await sendWorld([statusBundle(joaoAssignee, 'Em Teste'), statusBundle(joaoAssignee, 'Concluído')]);
      w.setNow(T0 + BUNDLE_TTL_MS + 1);
      const replies = await handleReminderSend(asker, sendData, w.deps);
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]!.text).toContain('Concluído');
      expect(w.sent[0]!.text).not.toContain('Em Teste');
      expect(replies).toEqual([{ kind: 'text', text: REMINDER_SENT('João Silva') }]);
    });

    it('a stale bundle whose assignee changed -> REMINDER_REASSIGNED, nothing sent', async () => {
      const w = await sendWorld([statusBundle(joaoAssignee), statusBundle({ displayName: 'Maria Souza' })]);
      w.setNow(T0 + BUNDLE_TTL_MS + 1);
      const replies = await handleReminderSend(asker, sendData, w.deps);
      expect(w.sent).toHaveLength(0);
      expect(replies).toEqual([{ kind: 'text', text: REMINDER_REASSIGNED }]);
    });

    it('a stale bundle whose refreshed card lost its assignee -> REMINDER_REASSIGNED, nothing sent', async () => {
      const w = await sendWorld([statusBundle(joaoAssignee), statusBundle(null)]);
      w.setNow(T0 + BUNDLE_TTL_MS + 1);
      expect(await handleReminderSend(asker, sendData, w.deps)).toEqual([{ kind: 'text', text: REMINDER_REASSIGNED }]);
      expect(w.sent).toHaveLength(0);
    });

    it('a stale bundle whose refresh fails -> the refresh error, nothing sent', async () => {
      const w = await sendWorld([statusBundle(joaoAssignee)]);
      w.deps.loadBundle = async () => { throw new Error('boom'); };
      w.setNow(T0 + BUNDLE_TTL_MS + 1);
      expect(await handleReminderSend(asker, sendData, w.deps)).toEqual([{ kind: 'text', text: JIRA_UNAVAILABLE }]);
      expect(w.sent).toHaveLength(0);
    });

    it('a fresh bundle whose assignee no longer matches the confirmed person -> REMINDER_REASSIGNED', async () => {
      const { deps, sent } = await sendWorld([statusBundle({ displayName: 'Maria Souza' })]);
      expect(await handleReminderSend(asker, sendData, deps)).toEqual([{ kind: 'text', text: REMINDER_REASSIGNED }]);
      expect(sent).toHaveLength(0);
    });

    it('sender failure -> REMINDER_SEND_FAILED (never success), audit logs failed, no error text leaks', async () => {
      const { deps } = await sendWorld([statusBundle(joaoAssignee)], { sendDm: async () => { throw new Error('boom 403 secret'); } });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const replies = await handleReminderSend(asker, sendData, deps);
      const lines = log.mock.calls.map((c) => String(c[0]));
      log.mockRestore();
      expect(replies).toEqual([{ kind: 'text', text: REMINDER_SEND_FAILED }]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('failed');
      expect(lines[0]).not.toContain('secret');
    });

    it('a different card bound than the payload card -> REMINDER_EXPIRED, nothing sent', async () => {
      const { deps, sent } = await sendWorld([statusBundle(joaoAssignee)]);
      expect(await handleReminderSend(asker, { ...sendData, cardKey: 'QZ-999' }, deps))
        .toEqual([{ kind: 'text', text: REMINDER_EXPIRED }]);
      expect(sent).toHaveLength(0);
    });

    it('binding gone -> REMINDER_EXPIRED', async () => {
      const { deps } = makeDeps({ sendReminder: { sendDm: async () => {} } });
      expect(await handleReminderSend(asker, sendData, deps)).toEqual([{ kind: 'text', text: REMINDER_EXPIRED }]);
    });

    it('deps.sendReminder undefined -> UNCONFIGURED_SEND', async () => {
      const { deps } = await sendWorld([statusBundle(joaoAssignee)], null);
      expect(await handleReminderSend(asker, sendData, deps)).toEqual([{ kind: 'text', text: UNCONFIGURED_SEND }]);
    });

    it.each([['a non-object', 'x'], ['a blank userId', { ...sendData, userId: ' ' }], ['a numeric note', { ...sendData, note: 5 }]])(
      'malformed payload (%s) -> SELECTION_INVALID, nothing sent', async (_n, data) => {
        const { deps, sent } = await sendWorld([statusBundle(joaoAssignee)]);
        expect(await handleReminderSend(asker, data, deps)).toEqual([{ kind: 'text', text: SELECTION_INVALID }]);
        expect(sent).toHaveLength(0);
      });

    it('the DM requester is the clicking user, falling back to UNKNOWN_REQUESTER without a name', async () => {
      const { deps, sent } = await sendWorld([statusBundle(joaoAssignee)]);
      await handleReminderSend(conv, sendData, deps);
      expect(sent[0]!.text).toContain(`**${UNKNOWN_REQUESTER}**`);
    });

    it('Cancelar -> REMINDER_CANCELLED', () => {
      expect(handleReminderCancel()).toEqual([{ kind: 'text', text: REMINDER_CANCELLED }]);
    });
  });
});

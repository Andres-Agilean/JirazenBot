import { describe, expect, it } from 'vitest';
import { handleMessage, JIRA_UNAVAILABLE, type HandleDeps } from '@/teams/handleMessage.js';
import { InMemoryBindingStore, BUNDLE_TTL_MS } from '@/teams/bindings.js';
import { testConfig } from './helpers.js';
import type { CardBundle } from '@/bundle/types.js';
import type { AssembleResult } from '@/bundle/assemble.js';

const T0 = 1_000_000;

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
    loadBundle: async (ref) => {
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
    const replies = await handleMessage('QZ-252', 'conv', deps);
    expect(answered).toHaveLength(1);
    expect(replies[0]).toContain('resposta para:');
    expect(replies[0]).toContain('QZ-252');
    expect(replies[0]).toContain('coletado às');
  });

  it('binds and answers the question when both are in one message', async () => {
    const { deps, answered } = makeDeps();
    await handleMessage('QZ-252 quem validou?', 'conv', deps);
    expect(answered).toEqual(['quem validou?']);
  });

  it('answers follow-ups against the bound card without re-fetching', async () => {
    const { deps, answered, loaded } = makeDeps();
    await handleMessage('QZ-252', 'conv', deps);
    await handleMessage('quem validou?', 'conv', deps);
    await handleMessage('e quando?', 'conv', deps);
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
    await handleMessage('QZ-252', 'conv', deps);
    await handleMessage('quem validou?', 'conv', deps);
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
    await handleMessage('QZ-252', 'conv', deps);
    await handleMessage('quem validou?', 'conv', deps);
    await handleMessage('AGL-900', 'conv', deps);
    expect(seen[2]).toEqual([]); // new card, fresh conversation
  });

  it('keeps conversations independent', async () => {
    const { deps } = makeDeps();
    await handleMessage('QZ-252', 'conv-a', deps);
    const replies = await handleMessage('quem validou?', 'conv-b', deps);
    expect(replies[0]).toContain('referência');
  });
});

describe('the bare-number guard (plan §6.1)', () => {
  it('does not rebind on a bare number when a card is already bound', async () => {
    const { deps, answered, loaded } = makeDeps();
    await handleMessage('QZ-252', 'conv', deps);
    await handleMessage('16467', 'conv', deps);
    expect(loaded).toHaveLength(1); // still the original card
    expect(answered[1]).toBe('16467'); // treated as a question, not a reference
  });

  it('binds a bare number as a Zendesk ticket when nothing is bound', async () => {
    const { deps, loaded } = makeDeps();
    await handleMessage('16467', 'conv', deps);
    expect(loaded).toEqual([{ system: 'zendesk', ticketId: '16467', explicit: false }]);
  });
});

describe('staleness', () => {
  it('refetches when the bundle is older than 15 minutes', async () => {
    const { deps, loaded, setNow } = makeDeps();
    await handleMessage('QZ-252', 'conv', deps);
    setNow(T0 + BUNDLE_TTL_MS + 1);
    await handleMessage('e agora?', 'conv', deps);
    expect(loaded).toHaveLength(2);
  });

  it('does not refetch inside the window', async () => {
    const { deps, loaded, setNow } = makeDeps();
    await handleMessage('QZ-252', 'conv', deps);
    setNow(T0 + BUNDLE_TTL_MS);
    await handleMessage('e agora?', 'conv', deps);
    expect(loaded).toHaveLength(1);
  });
});

describe('commands', () => {
  it('atualizar refetches and confirms', async () => {
    const { deps, loaded } = makeDeps();
    await handleMessage('QZ-252', 'conv', deps);
    const replies = await handleMessage('atualizar', 'conv', deps);
    expect(loaded).toHaveLength(2);
    expect(replies[0]).toContain('coletado às');
  });

  it('atualizar with nothing bound says so', async () => {
    const { deps, loaded } = makeDeps();
    const replies = await handleMessage('atualizar', 'conv', deps);
    expect(loaded).toHaveLength(0);
    expect(replies[0]).toContain('referência');
  });

  it('ajuda works with and without a binding', async () => {
    const { deps } = makeDeps();
    expect((await handleMessage('ajuda', 'conv', deps))[0]).toContain('chamado');
    await handleMessage('QZ-252', 'conv', deps);
    expect((await handleMessage('ajuda', 'conv', deps))[0]).toContain('QZ-252');
  });
});

describe('errors', () => {
  it('reports a card that was not found without binding anything', async () => {
    const { deps } = makeDeps({
      loadBundle: async () => ({ status: 'not_found', message: 'Não encontrei o card QZ-999.' }),
    });
    const replies = await handleMessage('QZ-999', 'conv', deps);
    expect(replies[0]).toContain('QZ-999');
    expect(await deps.store.get('conv')).toBeUndefined();
  });

  it('asks for a key on a multi-match, and never offers a numbered menu', async () => {
    const { deps } = makeDeps({
      loadBundle: async () => ({ status: 'ambiguous', side: 'jira', candidates: ['QZ-252', 'AGL-1500'] }),
    });
    const replies = await handleMessage('chamado 16467', 'conv', deps);
    expect(replies[0]).toContain('QZ-252');
    expect(replies[0]).toContain('AGL-1500');
    expect(replies[0]).toContain('chave');
    expect(replies[0]).not.toMatch(/^\s*1\)/m); // a numbered reply would collide with §6.1
  });

  it('reports a tenant failure in pt-BR instead of throwing', async () => {
    const { deps } = makeDeps({ loadBundle: async () => { throw new Error('ECONNREFUSED'); } });
    const replies = await handleMessage('QZ-252', 'conv', deps);
    expect(replies[0]).toMatch(/Jira|Zendesk/);
    expect(replies[0]).not.toContain('ECONNREFUSED');
  });

  it('reports an answer-service failure in pt-BR and keeps the binding', async () => {
    const { deps } = makeDeps({ answerFn: async () => { throw new Error('429 rate limit'); } });
    const replies = await handleMessage('QZ-252', 'conv', deps);
    expect(replies[0]).not.toContain('429');
    expect(replies[0].length).toBeGreaterThan(0);
  });

  it('prompts for a reference when nothing is bound and the text is not one', async () => {
    const { deps } = makeDeps();
    const replies = await handleMessage('bom dia, tudo bem?', 'conv', deps);
    expect(replies[0]).toContain('referência');
  });
});

describe('disambiguation renders candidates by side (finding 3)', () => {
  it('keeps Jira candidates as bare keys — they already round-trip as explicit references', async () => {
    const { deps } = makeDeps({
      loadBundle: async () => ({ status: 'ambiguous', side: 'jira', candidates: ['QZ-252', 'AGL-1500'] }),
    });
    const replies = await handleMessage('chamado 16467', 'conv', deps);
    expect(replies[0]).toContain('- QZ-252');
    expect(replies[0]).toContain('- AGL-1500');
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

    await handleMessage('QZ-100', 'conv', deps);

    const ambiguous = await handleMessage('QZ-252', 'conv', deps);
    expect(ambiguous[0]).not.toMatch(/^- 16467$/m); // a bare number would collide with §6.1
    expect(ambiguous[0]).not.toMatch(/^- 16468$/m);
    expect(ambiguous[0]).toContain('- chamado 16467');
    expect(ambiguous[0]).toContain('- chamado 16468');

    // Round trip: reply with exactly the string the bot offered.
    const rebind = await handleMessage('chamado 16467', 'conv', deps);
    expect(seenRefs.at(-1)).toEqual({ system: 'zendesk', ticketId: '16467', explicit: true });
    expect(rebind[0]).toContain('QZ-999'); // rebound to the new card, not answered from QZ-100
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
    await handleMessage('QZ-252', 'conv', deps);
    const replies = await handleMessage('atualizar', 'conv', deps);
    expect(replies[0]).toBe('Não encontrei o card QZ-252.');
    expect(replies[0]).not.toBe(JIRA_UNAVAILABLE);
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
    await handleMessage('QZ-252', 'conv', deps);
    const replies = await handleMessage('atualizar', 'conv', deps);
    expect(replies[0]).toContain('chave');
    expect(replies[0]).not.toBe(JIRA_UNAVAILABLE);
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
    await handleMessage('QZ-252', 'conv', deps);
    setNow(T0 + BUNDLE_TTL_MS + 1);
    const replies = await handleMessage('e agora?', 'conv', deps);
    expect(replies[0]).toBe('Não encontrei o card QZ-252.');
    expect(replies[0]).not.toBe(JIRA_UNAVAILABLE);
  });
});

import { expect, it } from 'vitest';
import { createSearchCache, searchPortfolio, SEARCH_CACHE_TTL_MS, type SearchDeps } from '@/teams/search.js';

const ticket = (id: number, updated: string) =>
  ({ ticketId: String(id), subject: `T${id}`, status: 'open', updatedAt: updated });

function deps(over: Partial<SearchDeps> = {}): SearchDeps {
  return {
    searchOrganizations: async () => [],
    openTicketsForOrganization: async () => [],
    searchActiveByText: async () => [],
    searchByZendeskIds: async () => [],
    ...over,
  };
}

it('multiple orgs → orgs outcome', async () => {
  const d = deps({ searchOrganizations: async () => [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] });
  expect(await searchPortfolio('a', d)).toMatchObject({ kind: 'orgs', orgs: [{ id: 1 }, { id: 2 }] });
});

it('single org + single ticket → bind (structured single match may bind; spec §4)', async () => {
  const d = deps({
    searchOrganizations: async () => [{ id: 1, name: 'Norte' }],
    openTicketsForOrganization: async () => [ticket(16467, '2026-09-28T10:00:00Z')],
  });
  const out = await searchPortfolio('norte', d);
  expect(out).toMatchObject({ kind: 'bind', ref: { system: 'zendesk', ticketId: '16467', explicit: true } });
});

it('single org + several tickets → cards: jira ref when mapped, zendesk ref when not, newest first', async () => {
  const d = deps({
    searchOrganizations: async () => [{ id: 1, name: 'Norte' }],
    openTicketsForOrganization: async () =>
      [ticket(100, '2026-09-01T00:00:00Z'), ticket(200, '2026-09-20T00:00:00Z')],
    searchByZendeskIds: async () => [{ issueKey: 'AGL-1', summary: 'S', status: 'Em Teste',
      updatedAt: '2026-09-21T00:00:00Z', zendeskId: '100' }],
  });
  const out = await searchPortfolio('norte', d);
  expect(out.kind).toBe('cards');
  if (out.kind !== 'cards') return;
  expect(out.total).toBe(2);
  expect(out.cards[0].updatedAt >= out.cards[1].updatedAt).toBe(true);
  expect(out.cards.map((c) => c.ref.system).sort()).toEqual(['jira', 'zendesk']);
});

it('no org + text hits → cards even for exactly one hit (text search never binds; spec §4)', async () => {
  const d = deps({ searchActiveByText: async () =>
    [{ issueKey: 'MDO-9', summary: 'Obra X', status: 'Em Desenvolvimento', updatedAt: '2026-09-25T00:00:00Z' }] });
  expect((await searchPortfolio('obra x', d))).toMatchObject({ kind: 'cards', total: 1 });
});

it('single org with zero tickets falls through to text search; nothing anywhere → none', async () => {
  const d = deps({ searchOrganizations: async () => [{ id: 1, name: 'Vazia' }] });
  expect(await searchPortfolio('vazia', d)).toEqual({ kind: 'none', name: 'vazia' });
});

it('caches identical searches for SEARCH_CACHE_TTL_MS and never caches failures (spec §6a)', async () => {
  let calls = 0; let t = 0;
  const d = deps({ searchOrganizations: async () => { calls++; if (calls === 1) throw new Error('429'); return []; } });
  const cache = createSearchCache(() => t);
  await expect(cache.run('norte', d)).rejects.toThrow();          // failure not cached
  await cache.run('norte', d);                                    // calls = 2, outcome cached
  await cache.run('norte', d);                                    // served from cache
  expect(calls).toBe(2);
  t = SEARCH_CACHE_TTL_MS + 1;
  await cache.run('norte', d);                                    // expired → refetch
  expect(calls).toBe(3);
});

it('org path makes at most 3 dependency calls and skips mapping when zero tickets (spec §6a)', async () => {
  const counts = { orgs: 0, tickets: 0, map: 0, text: 0 };
  const d: SearchDeps = {
    searchOrganizations: async () => { counts.orgs++; return [{ id: 1, name: 'Norte' }]; },
    openTicketsForOrganization: async () => { counts.tickets++; return []; },
    searchByZendeskIds: async () => { counts.map++; return []; },
    searchActiveByText: async () => { counts.text++; return []; },
  };
  await searchPortfolio('norte', d);
  expect(counts).toEqual({ orgs: 1, tickets: 1, map: 0, text: 1 });
});

it('empty name → none without calling any dep', async () => {
  const boom = async (): Promise<never> => { throw new Error('should not be called'); };
  const d: SearchDeps = { searchOrganizations: boom, openTicketsForOrganization: boom,
    searchActiveByText: boom, searchByZendeskIds: boom };
  expect(await searchPortfolio('   ', d)).toEqual({ kind: 'none', name: '' });
});

it('caps ids sent to searchByZendeskIds and cards at CARD_FETCH_CAP; total is pre-cap', async () => {
  let sent: string[] = [];
  const many = Array.from({ length: 30 }, (_, i) =>
    ticket(1000 + i, `2026-09-01T00:00:${String(i).padStart(2, '0')}Z`));
  const d = deps({
    searchOrganizations: async () => [{ id: 1, name: 'Norte' }],
    openTicketsForOrganization: async () => many,
    searchByZendeskIds: async (ids) => { sent = ids; return []; },
  });
  const out = await searchPortfolio('norte', d);
  expect(sent).toHaveLength(25);
  expect(out).toMatchObject({ kind: 'cards', total: 30 });
  if (out.kind === 'cards') expect(out.cards).toHaveLength(25);
});

it('labels and refs: jira AGL-1 / zendesk chamado N, explicit', async () => {
  const d = deps({
    searchOrganizations: async () => [{ id: 1, name: 'Norte' }],
    openTicketsForOrganization: async () =>
      [ticket(100, '2026-09-01T00:00:00Z'), ticket(200, '2026-09-20T00:00:00Z')],
    searchByZendeskIds: async () => [{ issueKey: 'AGL-1', summary: 'S', status: 'Em Teste',
      updatedAt: '2026-09-21T00:00:00Z', zendeskId: '100' }],
  });
  const out = await searchPortfolio('norte', d);
  if (out.kind !== 'cards') throw new Error('expected cards');
  expect(out.cards[0]).toMatchObject({ label: 'AGL-1', ref: { system: 'jira', issueKey: 'AGL-1', explicit: true } });
  expect(out.cards[1]).toMatchObject({ label: 'chamado 200', ref: { system: 'zendesk', ticketId: '200', explicit: true } });
});

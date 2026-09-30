import { describe, expect, it } from 'vitest';
import { InMemoryCandidateStore, matchCandidate, type CandidateSet } from '@/teams/candidates.js';
import { BINDING_TTL_MS, type Slot } from '@/teams/bindings.js';
import type { CardCandidate } from '@/teams/search.js';

const T0 = 1_000_000;
const cand = (key: string, summary: string): CardCandidate => ({
  ref: { system: 'jira', issueKey: key, explicit: true },
  label: key, summary, status: 'Aberto', updatedAt: '2026-09-01T00:00:00.000Z',
});
const set = (candidates: CardCandidate[]): CandidateSet => ({ name: 'x', candidates, createdAt: T0 });
const slot: Slot = { scope: 'shared', conversationId: 'c1' };

describe('InMemoryCandidateStore', () => {
  it('returns what was stored and isolates slots', async () => {
    const store = new InMemoryCandidateStore(() => T0);
    const s = set([cand('AGL-1', 'a')]);
    await store.set(slot, s);
    expect(await store.get(slot)).toBe(s);
    expect(await store.get({ scope: 'personal', conversationId: 'c1', userId: 'u' })).toBeUndefined();
  });

  it('expires after the binding TTL, on get', async () => {
    let now = T0;
    const store = new InMemoryCandidateStore(() => now);
    await store.set(slot, set([]));
    now = T0 + BINDING_TTL_MS;
    expect(await store.get(slot)).toBeDefined();
    now = T0 + BINDING_TTL_MS + 1;
    expect(await store.get(slot)).toBeUndefined();
  });

  it('delete removes', async () => {
    const store = new InMemoryCandidateStore(() => T0);
    await store.set(slot, set([]));
    await store.delete(slot);
    expect(await store.get(slot)).toBeUndefined();
  });
});

describe('matchCandidate', () => {
  const a = cand('AGL-1', 'Relatório de Conciliação');
  const b = cand('AGL-2', 'Integração bancária');
  const c = cand('AGL-3', 'Integração fiscal');
  const s = set([a, b, c]);

  it('matches one candidate by summary, accent- and case-insensitively', () => {
    expect(matchCandidate('CONCILIACAO', s)).toBe(a);
  });
  it('matches by label', () => {
    expect(matchCandidate('agl-2', s)).toBe(b);
  });
  it('several matches are ambiguous', () => {
    expect(matchCandidate('integracao', s)).toBe('ambiguous');
  });
  it('no match is null', () => {
    expect(matchCandidate('inexistente', s)).toBeNull();
  });
  it('text under 3 chars is null', () => {
    expect(matchCandidate('ag', s)).toBeNull();
  });
  it('regex-special characters are inert', () => {
    const paren = set([cand('AGL-4', 'Norte (Construtora) obra'), cand('AGL-5', 'Outro')]);
    expect(() => matchCandidate('norte (construtora)', paren)).not.toThrow();
    expect(matchCandidate('norte (construtora)', paren)).toBe(paren.candidates[0]);
    expect(matchCandidate('.*', paren)).toBeNull();
    expect(matchCandidate('(((', paren)).toBeNull();
  });
});

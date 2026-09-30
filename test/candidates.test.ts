import { describe, expect, it } from 'vitest';
import { InMemoryCandidateStore, matchCandidate, type CandidateSet } from '@/teams/candidates.js';
import { BINDING_TTL_MS, type Slot } from '@/teams/bindings.js';
import type { CardCandidate } from '@/teams/search.js';

const T0 = 1_000_000;
const cand = (key: string, summary: string): CardCandidate => ({
  ref: { system: 'jira', issueKey: key, explicit: true },
  label: key, summary, status: 'Aberto', updatedAt: '2026-09-01T00:00:00.000Z',
});
const set = (candidates: CardCandidate[]): CandidateSet => ({
  name: 'x',
  candidates,
  createdAt: T0,
  total: candidates.length,
  collectedAtMs: T0,
  history: [],
});
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

  it('matches by exact label, accent- and case-insensitively (spec §5a)', () => {
    expect(matchCandidate('agl-2', s)).toBe(b);
  });
  it('substring of summary falls through to null (spec §5a)', () => {
    expect(matchCandidate('CONCILIACAO', s)).toBeNull();
  });
  it('substring of label falls through to null (spec §5a)', () => {
    expect(matchCandidate('integracao', s)).toBeNull();
  });
  it('no match is null', () => {
    expect(matchCandidate('inexistente', s)).toBeNull();
  });
  it('text under 3 chars is null', () => {
    expect(matchCandidate('ag', s)).toBeNull();
  });
  it('same label listed twice returns one hit, deduped (not null)', () => {
    const dup = set([cand('AGL-7', 'Reforma do telhado'), cand('AGL-7', 'Reforma do telhado'), b]);
    expect(matchCandidate('AGL-7', dup)).toBe(dup.candidates[0]);
  });
  it('exact label with regex-special characters selects', () => {
    const z = { ...cand('AGL-9', 'z'), ref: { system: 'zendesk' as const, ticketId: '16467', explicit: true }, label: 'chamado 16467' };
    const withZ = set([a, b, z]);
    expect(matchCandidate('Chamado 16467', withZ)).toBe(z);
  });
  it('substring containing regex-special characters falls through (spec §5a)', () => {
    const paren = set([cand('AGL-4', 'Norte (Construtora) obra'), cand('AGL-5', 'Outro')]);
    expect(() => matchCandidate('norte (construtora)', paren)).not.toThrow();
    expect(matchCandidate('norte (construtora)', paren)).toBeNull();
  });
  it('a bare ticket number stays a question (bare-number guard), not a selection', () => {
    const z = { ...cand('AGL-9', 'z'), ref: { system: 'zendesk' as const, ticketId: '16467', explicit: true }, label: 'chamado 16467' };
    expect(matchCandidate('16467', set([z]))).toBeNull();
  });
  it('never matches a substring of a label or anything in the summary (spec §5a)', () => {
    const qz = set([cand('QZ-252', 'Relatório de Conciliação'), cand('QZ-300', 'Sim ou não')]);
    expect(matchCandidate('252', qz)).toBeNull();
    expect(matchCandidate('sim', qz)).toBeNull();
    expect(matchCandidate('conciliacao', qz)).toBeNull();
    expect(matchCandidate('qz', qz)).toBeNull();
  });
  it('regex-special characters in user input do not throw', () => {
    const paren = set([cand('AGL-4', 'Norte (Construtora) obra'), cand('AGL-5', 'Outro')]);
    expect(() => matchCandidate('.*', paren)).not.toThrow();
    expect(matchCandidate('.*', paren)).toBeNull();
    expect(matchCandidate('(((', paren)).toBeNull();
  });
});

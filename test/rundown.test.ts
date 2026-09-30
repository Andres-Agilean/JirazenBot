import { describe, expect, it } from 'vitest';
import {
  BUTTON_CAP, RUNDOWN_LINE_CAP, SELECT_ACTION, STALE_AFTER_DAYS, buildCandidateCard,
  renderOrgChoices, renderRundown,
} from '@/teams/rundown.js';
import type { CardCandidate } from '@/teams/search.js';

const NOW = Date.parse('2026-09-29T15:30:00.000Z'); // 12:30 in America/Sao_Paulo
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function jira(n: number, updatedAt = iso(NOW - DAY)): CardCandidate {
  return {
    ref: { system: 'jira', issueKey: `AGL-${n}`, explicit: true },
    label: `AGL-${n}`, summary: `Resumo ${n}`, status: 'Em Teste', updatedAt,
  };
}
const zen = (id: string): CardCandidate => ({
  ref: { system: 'zendesk', ticketId: id, explicit: true },
  label: `chamado ${id}`, summary: 'Assunto', status: 'open', updatedAt: iso(NOW - DAY),
});
const many = (n: number) => Array.from({ length: n }, (_, i) => jira(i + 1));

describe('caps', () => {
  it('are the specified values', () => {
    expect([RUNDOWN_LINE_CAP, BUTTON_CAP, STALE_AFTER_DAYS, SELECT_ACTION]).toEqual([8, 6, 14, 'selecionar']);
  });
});

describe('renderRundown', () => {
  it('renders the bold header with total and Sao Paulo time, and verbatim lines', () => {
    const out = renderRundown('Norte', [jira(1, '2026-09-27T12:00:00.000Z')], 1, NOW);
    const lines = out.split('\n');
    expect(lines[0]).toBe('**Norte — 1 cards ativos (coletado às 12:30)**');
    expect(lines[1]).toBe('- AGL-1 — Resumo 1 — Em Teste, atualizado 27/09');
  });

  it('caps lines and reports overflow using the total', () => {
    const out = renderRundown('Norte', many(10), 12, NOW);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(RUNDOWN_LINE_CAP);
    expect(out).toContain('e mais 4 cards — pergunte por um deles');
    expect(out).toContain('12 cards ativos');
  });

  it('has no overflow line at exactly the cap', () => {
    expect(renderRundown('N', many(RUNDOWN_LINE_CAP), RUNDOWN_LINE_CAP, NOW)).not.toContain('e mais');
  });

  it('adds a stale line when the oldest card is older than the threshold', () => {
    const old = jira(9, iso(NOW - (STALE_AFTER_DAYS + 1) * DAY));
    const out = renderRundown('N', [jira(1), old], 2, NOW);
    expect(out.split('\n').at(-1)).toBe('parado há mais tempo: AGL-9, sem atualização desde 14/09');
  });

  it('omits the stale line at exactly the threshold', () => {
    const edge = jira(9, iso(NOW - STALE_AFTER_DAYS * DAY));
    expect(renderRundown('N', [jira(1), edge], 2, NOW)).not.toContain('parado há');
  });

  it('finds the stale card even beyond the line cap', () => {
    const cards = [...many(9), jira(99, iso(NOW - 30 * DAY))];
    expect(renderRundown('N', cards, 10, NOW)).toContain('parado há mais tempo: AGL-99');
  });
});

describe('buildCandidateCard', () => {
  const card = (cs: CardCandidate[], total = cs.length) =>
    buildCandidateCard('Norte', cs, total) as any;

  it('is a plain Adaptive Card with a line per candidate', () => {
    const c = card([jira(1), zen('16467')]);
    expect(c.type).toBe('AdaptiveCard');
    expect(c.version).toBe('1.5');
    const text = JSON.stringify(c.body);
    expect(text).toContain('AGL-1');
    expect(text).toContain('chamado 16467');
  });

  it('button data carries system and issueKey / ticketId', () => {
    const c = card([jira(1), zen('16467')]);
    expect(c.actions.map((a: any) => a.data)).toEqual([
      { action: SELECT_ACTION, system: 'jira', id: 'AGL-1' },
      { action: SELECT_ACTION, system: 'zendesk', id: '16467' },
    ]);
    expect(c.actions[0].type).toBe('Action.Execute');
    expect(c.actions[0].verb).toBe(SELECT_ACTION);
  });

  it('caps buttons and notes the overflow', () => {
    const c = card(many(8));
    expect(c.actions).toHaveLength(BUTTON_CAP);
    expect(JSON.stringify(c.body)).toContain('e mais 2 — refine o nome');
  });

  it('no overflow note at exactly the button cap', () => {
    expect(JSON.stringify(card(many(BUTTON_CAP)).body)).not.toContain('refine o nome');
  });
});

describe('renderOrgChoices', () => {
  it('lists every org name', () => {
    const out = renderOrgChoices('norte', [{ id: 1, name: 'Norte A' }, { id: 2, name: 'Norte B' }]);
    expect(out).toContain('norte');
    expect(out).toContain('Norte A');
    expect(out).toContain('Norte B');
  });
});

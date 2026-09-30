import { describe, expect, it } from 'vitest';
import {
  STATUS_FILTER_MARKERS, computeAggregates, parseFollowup, renderCounts, renderPortfolio,
} from '@/teams/portfolio.js';
import { CARD_FETCH_CAP } from '@/fetch/zendesk.js';
import type { CardCandidate } from '@/teams/search.js';

const NOW = Date.parse('2026-09-29T15:30:00.000Z'); // 12:30 in America/Sao_Paulo
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function jira(key: string, o: Partial<CardCandidate> = {}): CardCandidate {
  return {
    ref: { system: 'jira', issueKey: key, explicit: true },
    label: key, summary: `Resumo ${key}`, status: 'Em Teste', updatedAt: iso(NOW - DAY), ...o,
  };
}
function zen(id: string, o: Partial<CardCandidate> = {}): CardCandidate {
  return {
    ref: { system: 'zendesk', ticketId: id, explicit: true },
    label: `chamado ${id}`, summary: `Assunto ${id}`, status: 'new', updatedAt: iso(NOW - DAY), ...o,
  };
}

describe('computeAggregates', () => {
  const cards = [
    jira('QZ-1', { status: 'Done', assignee: 'Gabriel', updatedAt: iso(NOW - 1 * DAY) }),
    jira('QZ-2', { status: 'Done', assignee: 'Ana', updatedAt: iso(NOW - 2 * DAY) }),
    jira('QZ-3', { status: 'Em Teste', assignee: 'Gabriel', updatedAt: iso(NOW - 3 * DAY) }),
    zen('16694', { status: 'open', updatedAt: iso(NOW - 30 * DAY) }),
    zen('17063', { status: 'open', updatedAt: iso(NOW - 20 * DAY) }),
    zen('17064', { status: 'new', updatedAt: iso(NOW - 13 * DAY) }),
  ];
  const a = computeAggregates(cards, 6, NOW);

  it('counts by status, count desc then label asc, verbatim', () => {
    expect(a.byStatus).toEqual([
      { status: 'Done', count: 2 }, { status: 'open', count: 2 },
      { status: 'Em Teste', count: 1 }, { status: 'new', count: 1 },
    ]);
  });
  it('counts by assignee with sem responsável, ordered', () => {
    expect(a.byAssignee).toEqual([
      { assignee: 'sem responsável', count: 3 }, { assignee: 'Gabriel', count: 2 }, { assignee: 'Ana', count: 1 },
    ]);
  });
  it('counts systems and total', () => {
    expect(a.jiraCount).toBe(3);
    expect(a.zendeskCount).toBe(3);
    expect(a.total).toBe(6);
    expect(a.capped).toBe(false);
  });
  it('stale is beyond the threshold, oldest first', () => {
    expect(a.stale.map((c) => c.label)).toEqual(['chamado 16694', 'chamado 17063']);
  });
  it('newest and oldest', () => {
    expect(a.newest?.label).toBe('QZ-1');
    expect(a.oldest?.label).toBe('chamado 16694');
  });
  it('capped when the pre-cap total reaches the fetch cap', () => {
    expect(computeAggregates(cards, CARD_FETCH_CAP, NOW).capped).toBe(true);
    expect(computeAggregates(cards, CARD_FETCH_CAP - 1, NOW).capped).toBe(false);
  });
  it('handles no cards', () => {
    const e = computeAggregates([], 0, NOW);
    expect(e.newest).toBeUndefined();
    expect(e.oldest).toBeUndefined();
    expect(e.stale).toEqual([]);
  });
});

describe('renderPortfolio', () => {
  const cards = [
    jira('QZ-306', { status: 'Done', assignee: 'Gabriel', zendeskId: '17044', updatedAt: '2026-09-29T11:00:00.000Z' }),
    zen('17063', { updatedAt: '2026-09-29T10:00:00.000Z' }),
    zen('16694', { updatedAt: '2026-08-31T12:00:00.000Z' }),
  ];
  const text = renderPortfolio('Acme', cards, computeAggregates(cards, 3, NOW), NOW);

  it('renders the exact skeleton', () => {
    expect(text.split('\n')).toEqual([
      'Acme — contexto de portfólio (coletado às 12:30)',
      '',
      '[estatísticas]',
      '- total: 3 atividades abertas (Jira: 1, Zendesk: 2)',
      '- por status: new: 2; Done: 1',
      '- por responsável: sem responsável: 2; Gabriel: 1',
      '- paradas há mais de 14 dias: chamado 16694 (desde 31/08)',
      '- mais recente: QZ-306 (29/09) · mais antiga: chamado 16694 (31/08)',
      '',
      '[atividades]',
      '[QZ-306] ↔ chamado 17044 — Resumo QZ-306 — Done — Gabriel — atualizado 29/09',
      '[chamado 17063] — Assunto 17063 — new — atualizado 29/09',
      '[chamado 16694] — Assunto 16694 — new — atualizado 31/08',
    ]);
  });
  it('omits the stale line when nothing is stale', () => {
    const fresh = [jira('QZ-1')];
    expect(renderPortfolio('X', fresh, computeAggregates(fresh, 1, NOW), NOW)).not.toContain('paradas');
  });
  it('words the capped total', () => {
    const many = Array.from({ length: CARD_FETCH_CAP }, (_, i) => jira(`QZ-${i}`));
    const t = renderPortfolio('X', many, computeAggregates(many, 40, NOW), NOW);
    expect(t).toContain(`- total: ${CARD_FETCH_CAP}+ atividades abertas (mostrando as ${CARD_FETCH_CAP} mais recentes)`);
  });
  it('ceiling: 25 max-length candidates stay under 6000 chars and bounded lines', () => {
    const big = Array.from({ length: CARD_FETCH_CAP }, (_, i) => jira(`QZ-${1000 + i}`, {
      summary: 'x'.repeat(80), status: 'Pronto para Delivery', assignee: 'Fulano de Tal Sobrenome',
      zendeskId: `${17000 + i}`, updatedAt: iso(NOW - (i + 1) * DAY * 2),
    }));
    const t = renderPortfolio('Organização Com Nome Longo', big, computeAggregates(big, 80, NOW), NOW);
    expect(t.length).toBeLessThan(6000);
    expect(t.split('\n').length).toBeLessThanOrEqual(CARD_FETCH_CAP + 8 + 3);
  });
});

describe('parseFollowup', () => {
  it.each([
    ['todos os de jira', { kind: 'expand', section: 'jira' }],
    ['Todas as de Zendesk', { kind: 'expand', section: 'zendesk' }],
    ['todos os de zendesk?', { kind: 'expand', section: 'zendesk' }],
    ['todas as de jira', { kind: 'expand', section: 'jira' }],
    ['mostra tudo', { kind: 'expand', section: 'all' }],
    ['Mostrar tudo!', { kind: 'expand', section: 'all' }],
    ['quantos?', { kind: 'counts' }],
    ['quantas', { kind: 'counts' }],
    ['quantos bloqueados?', { kind: 'counts', status: 'bloqueados' }],
    ['Quantas concluídas?', { kind: 'counts', status: 'concluidas' }],
    ['quantos reprovados', { kind: 'counts', status: 'reprovados' }],
  ])('matches %s', (text, expected) => {
    expect(parseFollowup(text)).toEqual(expected);
  });

  it.each([
    'quantos casos de teste passaram?',
    'quantos bloqueados existem no card?',
    'quantos comentários tem esse chamado',
    'me mostra tudo sobre o chamado',
    'mostra tudo o que o cliente disse',
    'quero ver todos os de jira por favor',
    'e todos os de jira têm responsável?',
    'quantos bloqueados abertos',
    'qual o status?',
    '',
  ])('does not intercept %s', (text) => {
    expect(parseFollowup(text)).toBeNull();
  });
});

describe('renderCounts', () => {
  const cards = [
    jira('QZ-1', { status: 'Bloqueado', assignee: 'Ana' }),
    jira('QZ-2', { status: 'Done', assignee: 'Ana' }),
    zen('1', { status: 'solved' }),
    zen('2', { status: 'open' }),
  ];
  const a = computeAggregates(cards, 4, NOW);

  it('without a filter leads with the total and lists breakdowns', () => {
    const lines = renderCounts('Acme', a).split('\n');
    expect(lines[0]).toBe('**Acme — 4 atividades abertas (Jira: 2, Zendesk: 2)**');
    expect(lines[1]).toBe('- por status: Bloqueado: 1; Done: 1; open: 1; solved: 1');
    expect(lines[2]).toBe('- por responsável: Ana: 2; sem responsável: 2');
  });
  it('with a status filter leads with the matching sum', () => {
    expect(renderCounts('Acme', a, 'bloqueados').split('\n')[0])
      .toBe('**Acme — 1 bloqueados (de 4 atividades abertas)**');
    expect(renderCounts('Acme', a, 'concluidos').split('\n')[0])
      .toBe('**Acme — 2 concluidos (de 4 atividades abertas)**');
  });
  it('exposes the status-word mapping', () => {
    expect(STATUS_FILTER_MARKERS.bloqueados).toContain('bloqueado');
    expect(STATUS_FILTER_MARKERS.concluidos).toContain('conclu');
  });
});

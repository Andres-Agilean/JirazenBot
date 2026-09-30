import { describe, expect, it } from 'vitest';
import {
  BUTTON_CAP, RUNDOWN_LINE_CAP, SELECT_ACTION, STALE_AFTER_DAYS, buildCandidateCard,
  buildRundownCard, renderOrgChoices, renderRundown, statusColor,
} from '@/teams/rundown.js';
import { CARD_FETCH_CAP } from '@/fetch/zendesk.js';
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
    expect(lines[1]).toBe('Cards (Jira)');
    expect(lines[2]).toBe('- AGL-1 — Resumo 1 — Em Teste, atualizado 27/09');
  });

  it('caps lines and reports overflow using the total', () => {
    const out = renderRundown('Norte', many(10), 12, NOW);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(RUNDOWN_LINE_CAP);
    expect(out).toContain('e mais 4 cards — pergunte por um deles');
    expect(out).toContain('12 cards ativos');
  });

  it('says "25+" instead of an exact count once the fetch cap is reached', () => {
    const capped = renderRundown('Norte', many(8), CARD_FETCH_CAP, NOW);
    expect(capped.split('\n')[0]).toBe(
      `**Norte — ${CARD_FETCH_CAP}+ cards ativos (mostrando os mais recentes) (coletado às 12:30)**`,
    );
    const exact = renderRundown('Norte', many(8), CARD_FETCH_CAP - 1, NOW);
    expect(exact.split('\n')[0]).toBe(`**Norte — ${CARD_FETCH_CAP - 1} cards ativos (coletado às 12:30)**`);
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
    expect(JSON.stringify(c.body)).toContain('mais 2 sem botão — digite o nome');
  });

  it('the card title uses the same capped count wording', () => {
    expect(card(many(3), CARD_FETCH_CAP).body[0].text).toBe(
      `Norte — ${CARD_FETCH_CAP}+ cards ativos (mostrando os mais recentes)`,
    );
    expect(card(many(3), 3).body[0].text).toBe('Norte — 3 cards ativos');
  });

  it('no overflow note at exactly the button cap', () => {
    expect(JSON.stringify(card(many(BUTTON_CAP)).body)).not.toContain('sem botão');
  });
});

describe('renderOrgChoices', () => {
  it('lists every org name', () => {
    const out = renderOrgChoices('norte', [{ id: 1, name: 'Norte A' }, { id: 2, name: 'Norte B' }]);
    expect(out).toContain('norte');
    expect(out).toContain('Norte A');
    expect(out).toContain('Norte B');
  });

  it('ends with the buscar instruction that round-trips', () => {
    const out = renderOrgChoices('norte', [{ id: 1, name: 'Norte A' }, { id: 2, name: 'Norte B' }]);
    expect(out.split('\n').at(-1)).toBe('Responda `buscar <nome da organização>` para escolher.');
  });
});

describe('statusColor', () => {
  it.each([
    ['Done', 'good'], ['Pronto para Produção', 'good'], ['Resolvido', 'good'], ['closed', 'good'], ['SOLVED', 'good'],
    ['Bloqueado', 'attention'], ['Blocked by vendor', 'attention'], ['Reprovado no teste', 'attention'],
    ['Em Teste', 'default'], ['open', 'default'], ['', 'default'],
  ])('%s -> %s', (status, color) => {
    expect(statusColor(status)).toBe(color);
  });
});

describe('buildRundownCard', () => {
  const build = (cs: CardCandidate[], total = cs.length) => buildRundownCard('Dalle', cs, total, NOW) as any;
  const texts = (c: any) => c.body.map((b: any) => b.text);

  it('is a plain Adaptive Card with a bold count title and no buttons', () => {
    const c = build([jira(1)]);
    expect(c.type).toBe('AdaptiveCard');
    expect(c.version).toBe('1.5');
    expect(c.actions).toBeUndefined();
    expect(c.body[0]).toMatchObject({ type: 'TextBlock', weight: 'Bolder', text: 'Dalle — 1 cards ativos' });
  });

  it('renders per card a bold-key line and a subtle colored status line with assignee when present', () => {
    const withAssignee = { ...jira(1, '2026-09-27T12:00:00.000Z'), status: 'Done', assignee: 'Ana Souza' };
    const c = build([withAssignee, { ...zen('16467'), status: 'Bloqueado' }]);
    // body[1] / body[4] are the section headers (layout changed by the sectioned rendering)
    expect(c.body[2]).toMatchObject({ text: '**AGL-1** — Resumo 1', wrap: true });
    expect(c.body[3]).toMatchObject({ text: 'Done · Ana Souza · atualizado 27/09', isSubtle: true, color: 'good' });
    expect(c.body[5].text).toBe('**chamado 16467** — Assunto');
    expect(c.body[6]).toMatchObject({ isSubtle: true, color: 'attention' });
    expect(c.body[6].text).not.toContain('undefined');
    expect(c.body[6].text.split(' · ')).toHaveLength(2);   // no assignee segment
  });

  it('caps cards at RUNDOWN_LINE_CAP and adds the overflow and stale lines as subtle blocks', () => {
    const old = jira(99, iso(NOW - 30 * DAY));
    const c = build([...many(RUNDOWN_LINE_CAP), old], RUNDOWN_LINE_CAP + 1);
    expect(texts(c).filter((t: string) => t.startsWith('**AGL-'))).toHaveLength(RUNDOWN_LINE_CAP);
    const overflow = c.body.find((b: any) => b.text?.startsWith('e mais'));
    expect(overflow).toMatchObject({ text: 'e mais 1 cards — pergunte por um deles', isSubtle: true });
    const stale = c.body.find((b: any) => b.text?.startsWith('parado há'));
    expect(stale).toMatchObject({ text: 'parado há mais tempo: AGL-99, sem atualização desde 30/08', isSubtle: true });
  });

  it('uses the capped count wording at the fetch cap', () => {
    expect(build(many(2), CARD_FETCH_CAP).body[0].text).toBe(
      `Dalle — ${CARD_FETCH_CAP}+ cards ativos (mostrando os mais recentes)`,
    );
  });
});

describe('buildCandidateCard line style', () => {
  it('uses the bold-key line and a colored status line, buttons unchanged', () => {
    const c = buildCandidateCard('Norte', [{ ...jira(1), status: 'Resolvido', assignee: 'Beto' }], 1) as any;
    expect(c.body[1].text).toBe('Cards (Jira)');   // section header
    expect(c.body[2].text).toBe('**AGL-1** — Resumo 1');
    expect(c.body[3]).toMatchObject({ isSubtle: true, color: 'good' });
    expect(c.body[3].text).toContain('Resolvido · Beto · atualizado');
    expect(c.actions).toHaveLength(1);
  });
});

describe('sectioned rendering (spec §10.4)', () => {
  const paired = { ...jira(1), zendeskId: '17058' };
  const unpaired = jira(2);
  const headers = (c: any) => c.body.filter((b: any) => b.weight === 'Bolder' && b.isSubtle).map((b: any) => b.text);
  const keyLines = (c: any) => c.body.map((b: any) => b.text).filter((t: string) => t.startsWith('**'));

  it('groups Jira then Zendesk, each under a bold subtle header, in both cards', () => {
    const cards = [zen('16467'), paired, unpaired];   // input order must not matter
    for (const c of [buildRundownCard('N', cards, 3, NOW), buildCandidateCard('N', cards, 3)] as any[]) {
      expect(headers(c)).toEqual(['Cards (Jira)', 'Chamados (Zendesk)']);
      expect(keyLines(c).map((t: string) => t.slice(0, 12))).toEqual(['**AGL-1** ↔ ', '**AGL-2** — ', '**chamado 16']);
    }
  });

  it('pairs a Jira line with its chamado; unpaired lines and Zendesk lines stay plain', () => {
    const c = buildRundownCard('N', [paired, unpaired, zen('16467')], 3, NOW) as any;
    expect(keyLines(c)).toEqual([
      '**AGL-1** ↔ chamado 17058 — Resumo 1',
      '**AGL-2** — Resumo 2',
      '**chamado 16467** — Assunto',
    ]);
  });

  it('omits an empty section: all-Jira and all-Zendesk', () => {
    const allJira = buildRundownCard('N', [paired], 1, NOW) as any;
    expect(headers(allJira)).toEqual(['Cards (Jira)']);
    const allZen = buildCandidateCard('N', [zen('1'), zen('2')], 2) as any;
    expect(headers(allZen)).toEqual(['Chamados (Zendesk)']);
  });

  it('the line cap applies across the whole rundown card, not per section', () => {
    const cards = [...many(RUNDOWN_LINE_CAP), zen('1')];   // Zendesk one falls past the cap
    const c = buildRundownCard('N', cards, cards.length, NOW) as any;
    expect(keyLines(c)).toHaveLength(RUNDOWN_LINE_CAP);
    expect(headers(c)).toEqual(['Cards (Jira)']);
  });

  it('the text fallback mirrors the grouping, with plain section-name lines and the pair', () => {
    const lines = renderRundown('N', [zen('16467'), paired, unpaired], 3, NOW).split('\n');
    expect(lines.slice(1)).toEqual([
      'Cards (Jira)',
      '- AGL-1 ↔ chamado 17058 — Resumo 1 — Em Teste, atualizado 28/09',
      '- AGL-2 — Resumo 2 — Em Teste, atualizado 28/09',
      'Chamados (Zendesk)',
      '- chamado 16467 — Assunto — open, atualizado 28/09',
    ]);
  });

  it('the text fallback omits an empty section', () => {
    expect(renderRundown('N', [zen('1')], 1, NOW)).not.toContain('Cards (Jira)');
    expect(renderRundown('N', [jira(1)], 1, NOW)).not.toContain('Chamados (Zendesk)');
  });
});

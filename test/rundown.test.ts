import { describe, expect, it } from 'vitest';
import {
  BUTTON_CAP, RUNDOWN_LINE_CAP, SELECT_ACTION, STALE_AFTER_DAYS, buildCandidateCard,
  buildRundownCard, renderOrgChoices, renderRundown, statusColor,
} from '@/teams/rundown.js';
import { CARD_FETCH_CAP } from '@/fetch/zendesk.js';
import type { CardCandidate } from '@/teams/search.js';
import { testConfig } from './helpers.js';

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

/** The markdown links the renderers must produce for testConfig's tenant. */
const J = (key: string) => `[${key}](https://your-tenant.atlassian.net/browse/${key})`;
const Z = (id: string) => `[chamado ${id}](https://your-subdomain.zendesk.com/agent/tickets/${id})`;

/** The bold key+summary TextBlock texts of a card, in order. */
const keyLines = (c: any): string[] => c.body.map((b: any) => b.text).filter((t: string) => t?.startsWith('**'));

const run = (name: string, cards: CardCandidate[], total = cards.length) =>
  renderRundown(name, cards, total, NOW, testConfig);

describe('caps', () => {
  it('are the specified values', () => {
    expect([RUNDOWN_LINE_CAP, BUTTON_CAP, STALE_AFTER_DAYS, SELECT_ACTION]).toEqual([8, 6, 14, 'selecionar']);
  });
});

describe('renderRundown', () => {
  it('renders the bold header with total and Sao Paulo time, and linked lines', () => {
    const lines = run('Norte', [jira(1, '2026-09-27T12:00:00.000Z')]).split('\n');
    expect(lines[0]).toBe('**Norte — 1 atividades abertas (coletado às 12:30)**');
    expect(lines[1]).toBe('Cards (Jira)');
    expect(lines[2]).toBe(`- ${J('AGL-1')} — Resumo 1 — Em Teste, atualizado 27/09`);
  });

  it('caps lines at RUNDOWN_LINE_CAP and names the hidden ones in the section', () => {
    const out = run('Norte', many(12));
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(RUNDOWN_LINE_CAP);
    expect(out).toContain(`e mais 4: ${['AGL-9', 'AGL-10', 'AGL-11', 'AGL-12'].map(J).join(', ')}`);
    expect(out).toContain('12 atividades abertas');
  });

  it('says "25+" instead of an exact count once the fetch cap is reached', () => {
    expect(run('Norte', many(8), CARD_FETCH_CAP).split('\n')[0]).toBe(
      `**Norte — ${CARD_FETCH_CAP}+ atividades abertas (mostrando as mais recentes) (coletado às 12:30)**`,
    );
    expect(run('Norte', many(8), CARD_FETCH_CAP - 1).split('\n')[0]).toBe(
      `**Norte — ${CARD_FETCH_CAP - 1} atividades abertas (coletado às 12:30)**`,
    );
  });

  it('has no overflow line at exactly the cap', () => {
    expect(run('N', many(RUNDOWN_LINE_CAP))).not.toContain('e mais');
  });

  it('adds a linked stale line at the card foot when the oldest card is past the threshold', () => {
    const old = jira(9, iso(NOW - (STALE_AFTER_DAYS + 1) * DAY));
    expect(run('N', [jira(1), old]).split('\n').at(-1)).toBe(
      `parado há mais tempo: ${J('AGL-9')}, sem atualização desde 14/09`,
    );
  });

  it('omits the stale line at exactly the threshold', () => {
    expect(run('N', [jira(1), jira(9, iso(NOW - STALE_AFTER_DAYS * DAY))])).not.toContain('parado há');
  });

  it('finds the stale card even beyond the line cap', () => {
    const cards = [...many(9), jira(99, iso(NOW - 30 * DAY))];
    expect(run('N', cards)).toContain(`parado há mais tempo: ${J('AGL-99')}`);
  });
});

describe('buildCandidateCard', () => {
  const card = (cs: CardCandidate[], total = cs.length) =>
    buildCandidateCard('Norte', cs, total, testConfig) as any;

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
    expect(c.actions[0].title).toBe('AGL-1');   // button titles stay plain labels
  });

  it('caps buttons and notes the overflow', () => {
    const c = card(many(8));
    expect(c.actions).toHaveLength(BUTTON_CAP);
    expect(JSON.stringify(c.body)).toContain('mais 2 sem botão — digite o nome');
  });

  it('the card title uses the same capped count wording', () => {
    expect(card(many(3), CARD_FETCH_CAP).body[0].text).toBe(
      `Norte — ${CARD_FETCH_CAP}+ atividades abertas (mostrando as mais recentes)`,
    );
    expect(card(many(3), 3).body[0].text).toBe('Norte — 3 atividades abertas');
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
  const build = (cs: CardCandidate[], total = cs.length) =>
    buildRundownCard('Dalle', cs, total, NOW, testConfig) as any;
  const texts = (c: any): string[] => c.body.map((b: any) => b.text);

  it('is a plain Adaptive Card with a bold count title and no buttons', () => {
    const c = build([jira(1)]);
    expect(c.type).toBe('AdaptiveCard');
    expect(c.version).toBe('1.5');
    expect(c.actions).toBeUndefined();
    expect(c.body[0]).toMatchObject({ type: 'TextBlock', weight: 'Bolder', size: 'Large', text: 'Dalle — 1 atividades abertas' });
    expect(c.body[0].isSubtle).toBeUndefined();
  });

  it('renders per card a bold linked-key line and a subtle colored status line with assignee when present', () => {
    const withAssignee = { ...jira(1, '2026-09-27T12:00:00.000Z'), status: 'Done', assignee: 'Ana Souza' };
    const c = build([withAssignee, { ...zen('16467'), status: 'Bloqueado' }]);
    // body[1] / body[4] are the section headers
    expect(c.body[2]).toMatchObject({ text: `**${J('AGL-1')}** — Resumo 1`, wrap: true });
    expect(c.body[3]).toMatchObject({ text: 'Done · Ana Souza · atualizado 27/09', isSubtle: true, color: 'good' });
    expect(c.body[5].text).toBe(`**${Z('16467')}** — Assunto`);
    expect(c.body[6]).toMatchObject({ isSubtle: true, color: 'attention' });
    expect(c.body[6].text).not.toContain('undefined');
    expect(c.body[6].text.split(' · ')).toHaveLength(2);   // no assignee segment
  });

  it('uses the capped count wording at the fetch cap', () => {
    expect(build(many(2), CARD_FETCH_CAP).body[0].text).toBe(
      `Dalle — ${CARD_FETCH_CAP}+ atividades abertas (mostrando as mais recentes)`,
    );
  });

  it('keeps the stale line global, as a subtle block at the card foot', () => {
    const cards = [...many(RUNDOWN_LINE_CAP), jira(99, iso(NOW - 30 * DAY))];
    const c = build(cards);
    expect(c.body.at(-2)).toMatchObject({
      text: `parado há mais tempo: ${J('AGL-99')}, sem atualização desde 30/08`, isSubtle: true,
    });
  });
});

describe('buildCandidateCard line style', () => {
  it('uses the bold linked-key line and a colored status line, buttons unchanged', () => {
    const c = buildCandidateCard('Norte', [{ ...jira(1), status: 'Resolvido', assignee: 'Beto' }], 1, testConfig) as any;
    expect(c.body[1].text).toBe('Cards (Jira)');   // section header
    expect(c.body[2].text).toBe(`**${J('AGL-1')}** — Resumo 1`);
    expect(c.body[3]).toMatchObject({ isSubtle: true, color: 'good' });
    expect(c.body[3].text).toContain('Resolvido · Beto · atualizado');
    expect(c.actions).toHaveLength(1);
  });
});

describe('sectioned rendering (spec §10.4)', () => {
  const paired = { ...jira(1), zendeskId: '17058' };
  const unpaired = jira(2);
  const headers = (c: any) => c.body.filter((b: any) => b.separator === true).map((b: any) => b.text);
  const both = (cards: CardCandidate[]) =>
    [buildRundownCard('N', cards, cards.length, NOW, testConfig), buildCandidateCard('N', cards, cards.length, testConfig)] as any[];

  it('groups Jira then Zendesk, each under a bold header, in both cards', () => {
    for (const c of both([zen('16467'), paired, unpaired])) {   // input order must not matter
      expect(headers(c)).toEqual(['Cards (Jira)', 'Chamados (Zendesk)']);
      expect(keyLines(c).map((t) => t.split(' — ')[1])).toEqual(['Resumo 1', 'Resumo 2', 'Assunto']);
    }
  });

  it('bolds and links the whole pair; unpaired and Zendesk lines link their single key', () => {
    const c = buildRundownCard('N', [paired, unpaired, zen('16467')], 3, NOW, testConfig) as any;
    expect(keyLines(c)).toEqual([
      `**${J('AGL-1')} ↔ ${Z('17058')}** — Resumo 1`,
      `**${J('AGL-2')}** — Resumo 2`,
      `**${Z('16467')}** — Assunto`,
    ]);
  });

  it('a paired line contains both hrefs', () => {
    const line = keyLines(buildCandidateCard('N', [paired], 1, testConfig) as any)[0];
    expect(line).toContain('(https://your-tenant.atlassian.net/browse/AGL-1)');
    expect(line).toContain('(https://your-subdomain.zendesk.com/agent/tickets/17058)');
  });

  it('omits an empty section: all-Jira and all-Zendesk', () => {
    expect(headers(buildRundownCard('N', [paired], 1, NOW, testConfig))).toEqual(['Cards (Jira)']);
    expect(headers(buildCandidateCard('N', [zen('1'), zen('2')], 2, testConfig))).toEqual(['Chamados (Zendesk)']);
  });

  it('title is Large+Bolder and not subtle; section headers are Bolder, default size, separated, not subtle', () => {
    for (const c of both([paired, zen('1')])) {
      expect(c.body[0]).toMatchObject({ weight: 'Bolder', size: 'Large' });
      expect(c.body[0].isSubtle).toBeUndefined();
      const hs = c.body.filter((b: any) => b.separator === true);
      expect(hs).toHaveLength(2);
      for (const h of hs) {
        expect(h.weight).toBe('Bolder');
        expect(h.size).toBeUndefined();
        expect(h.isSubtle).toBeUndefined();
      }
    }
  });

  it('the text fallback mirrors the grouping with linked keys and the linked pair', () => {
    const lines = run('N', [zen('16467'), paired, unpaired]).split('\n');
    expect(lines.slice(1)).toEqual([
      'Cards (Jira)',
      `- ${J('AGL-1')} ↔ ${Z('17058')} — Resumo 1 — Em Teste, atualizado 28/09`,
      `- ${J('AGL-2')} — Resumo 2 — Em Teste, atualizado 28/09`,
      'Chamados (Zendesk)',
      `- ${Z('16467')} — Assunto — open, atualizado 28/09`,
    ]);
  });

  it('the text fallback omits an empty section', () => {
    expect(run('N', [zen('1')])).not.toContain('Cards (Jira)');
    expect(run('N', [jira(1)])).not.toContain('Chamados (Zendesk)');
  });
});

describe('per-section overflow (spec §10.6)', () => {
  const overflows = (c: any): string[] => c.body.map((b: any) => b.text).filter((t: string) => t.startsWith('e mais'));
  const card = (cards: CardCandidate[]) => buildRundownCard('Dalle', cards, cards.length, NOW, testConfig) as any;
  const linked = (labels: string[]) => labels.map((l) => (l.startsWith('chamado') ? Z(l.slice(8)) : J(l))).join(', ');

  it('dalle-like: 7 Jira + 3 Zendesk under the global cap of 8 -> 7 Jira, 1 Zendesk, Zendesk overflows by 2', () => {
    const cards = [zen('101'), zen('102'), zen('103'), ...many(7)];   // Zendesk newer/first in input
    const c = card(cards);
    expect(keyLines(c)).toHaveLength(RUNDOWN_LINE_CAP);
    expect(keyLines(c).filter((t) => t.includes('/browse/'))).toHaveLength(7);
    expect(keyLines(c).filter((t) => t.includes('/agent/tickets/'))).toHaveLength(1);
    expect(overflows(c)).toEqual([`e mais 2: ${linked(['chamado 102', 'chamado 103'])}`]);
    // the overflow line sits right after its own section's lines, before nothing else
    const texts: string[] = c.body.map((b: any) => b.text);
    expect(texts.indexOf(overflows(c)[0])).toBeGreaterThan(texts.indexOf('Chamados (Zendesk)'));

    const lines = renderRundown('Dalle', cards, cards.length, NOW, testConfig).split('\n');
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(RUNDOWN_LINE_CAP);
    expect(lines.filter((l) => l.startsWith('e mais'))).toEqual(overflows(c));
    expect(lines.at(-1)).toBe(overflows(c)[0]);
  });

  it('a Jira overflow: 10 Jira + 2 Zendesk -> Jira shows 8 and overflows by 2; Zendesk section shows only its overflow', () => {
    const c = card([...many(10), zen('1'), zen('2')]);
    expect(keyLines(c)).toHaveLength(RUNDOWN_LINE_CAP);
    expect(overflows(c)).toEqual([
      `e mais 2: ${linked(['AGL-9', 'AGL-10'])}`,
      `e mais 2: ${linked(['chamado 1', 'chamado 2'])}`,
    ]);
    const texts: string[] = c.body.map((b: any) => b.text);
    expect(texts.indexOf('Chamados (Zendesk)')).toBeGreaterThan(texts.indexOf(overflows(c)[0]));
    expect(c.body.filter((b: any) => b.text?.startsWith('e mais')).every((b: any) => b.isSubtle)).toBe(true);
  });

  it('no mixed card-foot overflow: nothing hidden means no overflow line at all', () => {
    expect(overflows(card([...many(5), zen('1')]))).toEqual([]);
  });

  it('lists at most 10 labels per section, then an ellipsis', () => {
    const c = card(many(RUNDOWN_LINE_CAP + 12));
    const expected = linked(many(RUNDOWN_LINE_CAP + 12).slice(RUNDOWN_LINE_CAP, RUNDOWN_LINE_CAP + 10).map((x) => x.label));
    expect(overflows(c)).toEqual([`e mais 12: ${expected}, …`]);
    expect(run('N', many(RUNDOWN_LINE_CAP + 12))).toContain(`e mais 12: ${expected}, …`);
  });

  it('exactly 10 hidden has no ellipsis, and the old wording is gone', () => {
    expect(overflows(card(many(RUNDOWN_LINE_CAP + 10)))[0]).not.toContain('…');
    expect(run('N', many(RUNDOWN_LINE_CAP + 3))).not.toContain('pergunte');
  });
});

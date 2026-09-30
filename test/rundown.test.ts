import { describe, expect, it } from 'vitest';
import {
  BUTTON_CAP, SECTION_LINE_CAP, SELECT_ACTION, STALE_AFTER_DAYS, buildCandidateCard,
  buildDistributionCard, buildRundownCard, renderDistribution, renderOrgChoices, renderRundown, statusColor,
} from '@/teams/rundown.js';
import { computeAggregates } from '@/teams/portfolio.js';
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
    expect([SECTION_LINE_CAP, BUTTON_CAP, STALE_AFTER_DAYS, SELECT_ACTION]).toEqual([5, 6, 14, 'selecionar']);
  });
});

describe('renderRundown', () => {
  it('renders the bold header with total and Sao Paulo time, and linked lines', () => {
    const lines = run('Norte', [jira(1, '2026-09-27T12:00:00.000Z')]).split('\n');
    expect(lines[0]).toBe('**Norte — 1 atividades abertas (coletado às 12:30)**');
    expect(lines[1]).toBe('Cards (Jira)');
    expect(lines[2]).toBe(`- ${J('AGL-1')} — Resumo 1 — Em Teste, atualizado 27/09`);
  });

  it('caps a section at SECTION_LINE_CAP and names the hidden ones in that section', () => {
    const out = run('Norte', many(12));
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(SECTION_LINE_CAP);
    expect(out).toContain(`e mais 7: ${['AGL-6', 'AGL-7', 'AGL-8', 'AGL-9', 'AGL-10', 'AGL-11', 'AGL-12'].map(J).join(', ')}`);
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

  it('has no overflow line at exactly the section cap, and one at cap + 1', () => {
    expect(run('N', many(SECTION_LINE_CAP))).not.toContain('e mais');
    expect(run('N', many(SECTION_LINE_CAP + 1))).toContain(`e mais 1: ${J(`AGL-${SECTION_LINE_CAP + 1}`)}`);
  });

  it('adds a linked stale line at the section foot when its oldest card is past the threshold', () => {
    const old = jira(9, iso(NOW - (STALE_AFTER_DAYS + 1) * DAY));
    expect(run('N', [jira(1), old]).split('\n').at(-1)).toBe(
      `parado há mais tempo: ${J('AGL-9')}, sem atualização desde 14/09`,
    );
  });

  it('omits the stale line at exactly the threshold', () => {
    expect(run('N', [jira(1), jira(9, iso(NOW - STALE_AFTER_DAYS * DAY))])).not.toContain('parado há');
  });

  it('finds the stale card even beyond the section line cap', () => {
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

  it('renders the stale line as a subtle block at its section foot', () => {
    const cards = [...many(SECTION_LINE_CAP), jira(99, iso(NOW - 30 * DAY))];
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

  const stales = (c: any): string[] => c.body.map((b: any) => b.text).filter((t: string) => t.startsWith('parado há'));
  const old = (n: number) => jira(n, iso(NOW - 30 * DAY));   // 30 days untouched -> stale

  it('dalle-like: 7 Jira + 3 Zendesk -> 5 Jira + its overflow and stale, then 3 Zendesk with neither', () => {
    const cards = [zen('101'), zen('102'), zen('103'), ...many(6), old(7)];
    const c = card(cards);
    expect(keyLines(c)).toHaveLength(SECTION_LINE_CAP + 3);
    expect(keyLines(c).filter((t) => t.includes('/browse/'))).toHaveLength(SECTION_LINE_CAP);
    expect(keyLines(c).filter((t) => t.includes('/agent/tickets/'))).toHaveLength(3);
    expect(overflows(c)).toEqual([`e mais 2: ${linked(['AGL-6', 'AGL-7'])}`]);
    expect(stales(c)).toEqual([`parado há mais tempo: ${J('AGL-7')}, sem atualização desde 30/08`]);   // hidden items count
    // order: Jira lines, Jira overflow, Jira stale, then the Zendesk header
    const texts: string[] = c.body.map((b: any) => b.text);
    expect(texts.indexOf(overflows(c)[0])).toBeGreaterThan(texts.indexOf(keyLines(c)[SECTION_LINE_CAP - 1]));
    expect(texts.indexOf(stales(c)[0])).toBe(texts.indexOf(overflows(c)[0]) + 1);
    expect(texts.indexOf('Chamados (Zendesk)')).toBeGreaterThan(texts.indexOf(stales(c)[0]));

    const lines = renderRundown('Dalle', cards, cards.length, NOW, testConfig).split('\n');
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(SECTION_LINE_CAP + 3);
    expect(lines.filter((l) => l.startsWith('e mais'))).toEqual(overflows(c));
    expect(lines.filter((l) => l.startsWith('parado há'))).toEqual(stales(c));
    expect(lines.indexOf(stales(c)[0])).toBe(lines.indexOf(overflows(c)[0]) + 1);
  });

  it('each section gets its own stale line, from its own oldest item', () => {
    const oldZ = { ...zen('55'), updatedAt: iso(NOW - 20 * DAY) };
    const c = card([...many(2), old(3), oldZ, zen('56')]);
    expect(stales(c)).toEqual([
      `parado há mais tempo: ${J('AGL-3')}, sem atualização desde 30/08`,
      `parado há mais tempo: ${Z('55')}, sem atualização desde 09/09`,
    ]);
    const lines = renderRundown('N', [...many(2), old(3), oldZ, zen('56')], 5, NOW, testConfig).split('\n');
    expect(lines.filter((l) => l.startsWith('parado há'))).toEqual(stales(c));
    // no card-global stale line at the foot: the last line is the Zendesk section's own
    expect(lines.at(-1)).toBe(stales(c)[1]);
  });

  it('a section under the cap with fresh items has neither overflow nor stale', () => {
    const c = card([...many(SECTION_LINE_CAP - 1), zen('1')]);
    expect(overflows(c)).toEqual([]);
    expect(stales(c)).toEqual([]);
  });

  it('boundary: exactly SECTION_LINE_CAP has no overflow, one more names it; each section caps independently', () => {
    expect(overflows(card(many(SECTION_LINE_CAP)))).toEqual([]);
    expect(overflows(card(many(SECTION_LINE_CAP + 1)))).toEqual([`e mais 1: ${J(`AGL-${SECTION_LINE_CAP + 1}`)}`]);
    const both = card([...many(SECTION_LINE_CAP + 1), ...Array.from({ length: SECTION_LINE_CAP + 2 }, (_, i) => zen(`${i + 1}`))]);
    expect(keyLines(both)).toHaveLength(SECTION_LINE_CAP * 2);
    expect(overflows(both)).toHaveLength(2);
    expect(overflows(both)[1]).toBe(`e mais 2: ${linked(['chamado 6', 'chamado 7'])}`);
    expect(both.body.filter((b: any) => b.text?.startsWith('e mais')).every((b: any) => b.isSubtle)).toBe(true);
  });

  it('lists at most 10 labels per section, then an ellipsis', () => {
    const n = SECTION_LINE_CAP + 12;
    const expected = linked(many(n).slice(SECTION_LINE_CAP, SECTION_LINE_CAP + 10).map((x) => x.label));
    expect(overflows(card(many(n)))).toEqual([`e mais 12: ${expected}, …`]);
    expect(run('N', many(n))).toContain(`e mais 12: ${expected}, …`);
  });

  it('exactly 10 hidden has no ellipsis, and the old wording is gone', () => {
    expect(overflows(card(many(SECTION_LINE_CAP + 10)))[0]).not.toContain('…');
    expect(run('N', many(SECTION_LINE_CAP + 3))).not.toContain('pergunte');
  });
});

describe('distribution card', () => {
  const card = (id: number, status: string, assignee?: string): CardCandidate => ({
    ...jira(id), status, ...(assignee ? { assignee } : {}),
  });
  const cards: CardCandidate[] = [
    card(1, 'Done', 'Ana'), card(2, 'Done'), card(3, 'Blocked', 'Ana'), card(4, 'Em Teste', 'Bia'),
    zen('10'), { ...zen('11'), status: 'new' },
  ];
  const texts = (c: any): string[] => c.body.map((b: any) => b.text);
  const build = (dim: 'status' | 'assignee', cs = cards) =>
    buildDistributionCard('Acme', cs, dim, cs.length, NOW, testConfig) as any;

  it('status: prominent header, sections, one colored bucket line each, coletado as subtle footer', () => {
    const c = build('status');
    expect(c.body[0]).toMatchObject({ text: 'Acme — 6 atividades abertas', weight: 'Bolder', size: 'Large' });
    expect(texts(c)).toEqual([
      'Acme — 6 atividades abertas',
      'Cards (Jira)',
      `**Done — 2:** **${J('AGL-1')}**, **${J('AGL-2')}**`,
      `**Blocked — 1:** **${J('AGL-3')}**`,
      `**Em Teste — 1:** **${J('AGL-4')}**`,
      'Chamados (Zendesk)',
      `**new — 1:** **${Z('11')}**`,
      `**open — 1:** **${Z('10')}**`,
      'coletado às 12:30',
    ]);
    expect(c.body[1]).toMatchObject({ weight: 'Bolder', separator: true });
    expect(c.body[2].color).toBe('good');
    expect(c.body[3].color).toBe('attention');
    expect(c.body[4].color).toBe('default');
    expect(c.body.at(-1)).toMatchObject({ isSubtle: true });
  });
  it('status: omits an empty section', () => {
    const c = build('status', [card(1, 'Done')]);
    expect(texts(c)).not.toContain('Chamados (Zendesk)');
    expect(texts(c)).toContain('Cards (Jira)');
  });
  it('status: caps keys per bucket with a plain "e mais N" tail and no links in it', () => {
    const big = Array.from({ length: SECTION_LINE_CAP + 3 }, (_, i) => card(i + 1, 'Done'));
    const line = texts(build('status', big))[2];
    expect(line.startsWith(`**Done — ${SECTION_LINE_CAP + 3}:** `)).toBe(true);
    expect(line.endsWith(' e mais 3')).toBe(true);
    expect(line).toContain(J(`AGL-${SECTION_LINE_CAP}`));
    expect(line).not.toContain(`AGL-${SECTION_LINE_CAP + 1}`);
  });
  it('assignee: sectionless, one default-colored line per bucket, sem responsável in tally order', () => {
    const c = build('assignee');
    expect(texts(c)).toEqual([
      'Acme — 6 atividades abertas',
      `**sem responsável — 3:** **${J('AGL-2')}**, **${Z('10')}**, **${Z('11')}**`,
      `**Ana — 2:** **${J('AGL-1')}**, **${J('AGL-3')}**`,
      `**Bia — 1:** **${J('AGL-4')}**`,
      'coletado às 12:30',
    ]);
    expect(c.body.slice(1, -1).every((b: any) => b.color === undefined)).toBe(true);
  });
  it('bucket counts equal computeAggregates counts', () => {
    const a = computeAggregates(cards, cards.length, NOW);
    const c = build('status');
    for (const s of [...a.jiraByStatus, ...a.zendeskByStatus]) {
      expect(texts(c).some((t) => t?.startsWith(`**${s.status} — ${s.count}:**`))).toBe(true);
    }
    const ca = build('assignee');
    for (const s of a.byAssignee) {
      expect(texts(ca).some((t) => t?.startsWith(`**${s.assignee} — ${s.count}:**`))).toBe(true);
    }
  });
  it('renderDistribution mirrors the card as plain text', () => {
    const t = renderDistribution('Acme', cards, 'status', cards.length, NOW, testConfig).split('\n');
    expect(t[0]).toBe('**Acme — 6 atividades abertas (coletado às 12:30)**');
    expect(t).toContain('Cards (Jira)');
    expect(t).toContain(`- **Done — 2:** **${J('AGL-1')}**, **${J('AGL-2')}**`);
    expect(t).toContain('Chamados (Zendesk)');
    const ta = renderDistribution('Acme', cards, 'assignee', cards.length, NOW, testConfig).split('\n');
    expect(ta).toContain(`- **Ana — 2:** **${J('AGL-1')}**, **${J('AGL-3')}**`);
    expect(ta).not.toContain('Cards (Jira)');
  });
});

import { describe, expect, it } from 'vitest';
import type { CardBundle } from '@/bundle/types.js';
import { compressCitations, stylePortfolioAnswer } from '@/teams/citations.js';
import type { CardCandidate } from '@/teams/search.js';
import { testConfig } from './helpers.js';

describe('compressCitations', () => {
  it('shortens a jira comment citation', () => {
    expect(compressCitations('[comentário jira 10234]')).toBe('[jira 10234]');
  });

  it('elides a long zendesk comment id to its last 4 digits', () => {
    expect(compressCitations('[comentário zendesk 40123456789]')).toBe('[zendesk …6789]');
  });

  it('keeps a short zendesk comment id whole (6 digits or fewer)', () => {
    expect(compressCitations('[comentário zendesk 90001]')).toBe('[zendesk 90001]');
    expect(compressCitations('[comentário zendesk 123456]')).toBe('[zendesk 123456]');
    expect(compressCitations('[comentário zendesk 1234567]')).toBe('[zendesk …4567]');
  });

  it('drops the "campo" prefix', () => {
    expect(compressCitations('[campo Status]')).toBe('[Status]');
    expect(compressCitations('[campo customfield_10042]')).toBe('[customfield_10042]');
  });

  it('handles a mixed sentence', () => {
    expect(
      compressCitations('Falhou [comentário jira 11] e o cliente confirmou [comentário zendesk 40123456789] [campo Status].'),
    ).toBe('Falhou [jira 11] e o cliente confirmou [zendesk …6789] [Status].');
  });

  describe('with a bundle', () => {
    const bundle = {
      fetchedAt: '2026-08-14T17:32:00.000Z',
      surface: 'dm',
      jira: {
        issueId: '1', issueKey: 'QZ-1', fields: {}, statusHistory: [],
        comments: [{ id: '41713', author: 'a', createdAt: '2026-08-11T17:34:00Z', body: 'x' }],
      },
      zendesk: {
        ticketId: '9', subject: 's', status: 'open', priority: null, createdAt: '', updatedAt: '',
        internalNotesOmitted: false,
        comments: [{ id: 40123456789, author: 'b', isPublic: false, createdAt: '2026-08-14T14:52:00Z', body: 'y' }],
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    } as CardBundle;

    it('renders a known jira comment as its timestamp', () => {
      expect(compressCitations('[comentário jira 41713]', bundle)).toBe('[jira 11/08 14:34]');
    });

    it('renders a known zendesk comment (numeric id) as its timestamp', () => {
      expect(compressCitations('[comentário zendesk 40123456789]', bundle)).toBe('[zendesk 14/08 11:52]');
    });

    it('falls back to the id forms for ids not in the bundle', () => {
      expect(compressCitations('[comentário jira 99999] [comentário zendesk 40999999999]', bundle)).toBe(
        '[jira 99999] [zendesk …9999]',
      );
    });

    it('handles the invented [nota interna <id>] form like a zendesk comment', () => {
      expect(compressCitations('[nota interna 40123456789]', bundle)).toBe('[nota interna 14/08 11:52]');
      expect(compressCitations('[nota interna 40999999999]', bundle)).toBe('[nota interna …9999]');
      expect(compressCitations('[nota interna 90001]', bundle)).toBe('[nota interna 90001]');
      expect(compressCitations('[nota interna 40999999999]')).toBe('[nota interna …9999]');
    });

    it('drops a comma tail (variant labels the model sometimes emits)', () => {
      expect(compressCitations('[comentário jira 41713, André Marques]', bundle)).toBe('[jira 11/08 14:34]');
      expect(compressCitations('[comentário zendesk 40123456789, Ana]', bundle)).toBe('[zendesk 14/08 11:52]');
      expect(compressCitations('[nota interna 40999999999, Ana]', bundle)).toBe('[nota interna …9999]');
      expect(compressCitations('[comentário jira 99999, X]')).toBe('[jira 99999]');
    });

    it('stays idempotent after dropping a comma tail', () => {
      const once = compressCitations('[comentário jira 41713, André Marques]', bundle);
      expect(compressCitations(once, bundle)).toBe(once);
    });

    it('is idempotent with nota interna citations', () => {
      const once = compressCitations('[nota interna 40123456789] [nota interna 40999999999]', bundle);
      expect(compressCitations(once, bundle)).toBe(once);
    });

    it('is idempotent with timestamps', () => {
      const once = compressCitations('[comentário jira 41713] [comentário zendesk 40123456789] [campo Status]', bundle);
      expect(once).toBe('[jira 11/08 14:34] [zendesk 14/08 11:52] [Status]');
      expect(compressCitations(once, bundle)).toBe(once);
    });
  });

  it('is idempotent', () => {
    const raw = '[comentário jira 11] [comentário zendesk 40123456789] [campo Status]';
    const once = compressCitations(raw);
    expect(compressCitations(once)).toBe(once);
  });

  it('leaves text without citations untouched', () => {
    const text = '**Sem citação** - item [1] e [outro] (campo) comentário jira 5';
    expect(compressCitations(text)).toBe(text);
  });

  // Spec §13 (owner screenshot 11:03): the internal [estatísticas] block label never reaches the user.
  describe('[estatísticas] is stripped at display time (spec §13)', () => {
    it.each([
      ['Distribuição por responsável, conforme [estatísticas]: João 2', 'Distribuição por responsável: João 2'],
      ['Isso, segundo o bloco [estatísticas], são 5 cards.', 'Isso, são 5 cards.'],
      ['são 5 [estatísticas].', 'são 5.'],
      ['são 5 [estatisticas].', 'são 5.'],
      ['Distribuição, conforme [estatisticas]: ok', 'Distribuição: ok'],
      ['veja [estatísticas] e [QZ-306]', 'veja e [QZ-306]'],
      // Leftover punctuation at a line start (incl. behind a bold opener) is tidied; casing is not touched.
      ['Conforme [estatísticas], são 5 abertas.', 'são 5 abertas.'],
      ['**Conforme [estatísticas], são 5 abertas**', '**são 5 abertas**'],
      ['Resumo\n**Segundo o bloco [estatísticas]: são 5**', 'Resumo\n**são 5**'],
      ['Distribuição por responsável, conforme [estatísticas]: João 2', 'Distribuição por responsável: João 2'],
    ])('%s', (input, expected) => {
      expect(compressCitations(input)).toBe(expected);
    });

    it('a text with only card citations is a no-op', () => {
      const text = 'Veja [QZ-306] e [chamado 17063].';
      expect(compressCitations(text)).toBe(text);
    });
  });

  describe('candidate labels pass through untouched', () => {
    // Flipped by spec §13: `[estatísticas]` is no longer a passthrough label (see the strip tests below).
    const text = '[QZ-306] e [chamado 17063]';
    const collidingBundle = {
      fetchedAt: '2026-08-14T17:32:00.000Z',
      surface: 'dm',
      jira: {
        issueId: '17063', issueKey: 'QZ-306', fields: {}, statusHistory: [],
        comments: [{ id: '17063', author: 'a', createdAt: '2026-08-11T17:34:00Z', body: 'x' }],
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    } as CardBundle;

    it('leaves them unchanged without a bundle', () => {
      expect(compressCitations(text)).toBe(text);
    });

    it('leaves them unchanged with a bundle whose ids collide', () => {
      expect(compressCitations(text, collidingBundle)).toBe(text);
    });
  });
});

// Spec §14: the Claude-over-portfolio answer is styled like the deterministic cards.
describe('stylePortfolioAnswer (spec §14)', () => {
  const cand = (key: string, status: string, assignee?: string): CardCandidate => ({
    ref: { system: 'jira', issueKey: key, explicit: true },
    label: key, summary: 's', status, updatedAt: '2026-09-20T10:00:00.000Z', ...(assignee ? { assignee } : {}),
  });
  const set = {
    candidates: [
      cand('QZ-306', 'Done', 'Ana Souza'),
      cand('QZ-308', 'Em Teste', 'João Silva'),
      cand('QZ-400', 'Pronto (fase 2)', 'Ana (dev)'),
    ],
  };
  const J = (k: string) => `[${k}](https://your-tenant.atlassian.net/browse/${k})`;
  const Z = (id: string) => `[chamado ${id}](https://your-subdomain.zendesk.com/agent/tickets/${id})`;
  const style = (t: string) => stylePortfolioAnswer(t, set, testConfig);

  it('linkifies jira and zendesk citations as bold links', () => {
    expect(style('veja [QZ-308] e [chamado 17063].')).toBe(`veja **${J('QZ-308')}** e **${Z('17063')}**.`);
  });

  it('a citation inside an existing bold span is linkified without nesting bold', () => {
    const out = style('**Destaque: [QZ-308] parado**');
    expect(out).toBe(`**Destaque: ${J('QZ-308')} parado**`);
    expect(out).not.toContain('****');
  });

  it('leaves non-candidate brackets and existing links alone', () => {
    expect(style('[foo X] e [outro] e [QZ-1](http://x)')).toBe('[foo X] e [outro] e [QZ-1](http://x)');
  });

  it('bolds statuses and assignees from the set outside bold spans, never inside link text', () => {
    expect(style('[QZ-306] Done com Ana Souza')).toBe(`**${J('QZ-306')}** **Done** com **Ana Souza**`);
  });

  it('leaves a known string inside an existing bold span alone', () => {
    expect(style('**Done** e Done')).toBe('**Done** e **Done**');
  });

  it('respects word boundaries', () => {
    expect(style('Undone e Doner')).toBe('Undone e Doner');
  });

  it('escapes regex metacharacters in statuses and assignees', () => {
    expect(style('Pronto (fase 2) por Ana (dev).')).toBe('**Pronto (fase 2)** por **Ana (dev)**.');
  });

  it('prefers the longest known string', () => {
    const s = { candidates: [cand('A-1', 'Em', 'x'), cand('A-2', 'Em Teste')] };
    expect(stylePortfolioAnswer('Em Teste', s, testConfig)).toBe('**Em Teste**');
  });

  it('runs the [estatísticas] strip first', () => {
    expect(style('são 5 [estatísticas].')).toBe('são 5.');
  });

  it('uses only the stored set: no set vocabulary means no bolding', () => {
    expect(stylePortfolioAnswer('Done e Em Teste', { candidates: [] }, testConfig)).toBe('Done e Em Teste');
  });
});

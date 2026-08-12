import { describe, expect, it } from 'vitest';
import { renderBundle } from '../src/bundle/render.js';
import { assembleBundle } from '../src/bundle/assemble.js';
import { JiraClient } from '../src/fetch/jira.js';
import { ZendeskClient } from '../src/fetch/zendesk.js';
import { Resolver } from '../src/resolve/resolver.js';
import { ZendeskLinksStrategy } from '../src/resolve/strategies.js';
import type { CardBundle } from '../src/bundle/types.js';
import { fixture, makeFetch, testConfig } from './helpers.js';

async function makeBundle(surface: 'dm' | 'multiparty') {
  const f = makeFetch({
    '/rest/api/3/issue/QZ-252/comment': fixture('jira-comments'),
    '/rest/api/3/issue/QZ-252': fixture('jira-issue'),
    '/rest/api/3/issue/42395/comment': fixture('jira-comments'),
    '/rest/api/3/issue/42395': fixture('jira-issue'),
    '/api/v2/tickets/16467/comments': fixture('zendesk-comments'),
    '/api/v2/tickets/16467.json': fixture('zendesk-ticket'),
    '/links': fixture('links-single'),
  });
  const r = await assembleBundle(
    { system: 'jira', issueKey: 'QZ-252', explicit: true },
    { jira: new JiraClient(testConfig, f), zendesk: new ZendeskClient(testConfig, f), resolver: new Resolver([new ZendeskLinksStrategy(testConfig, f)]) },
    surface,
    () => new Date('2026-08-10T18:00:00Z'),
  );
  if (r.status !== 'ok') throw new Error('fixture bundle failed');
  return r.bundle;
}

describe('renderBundle', () => {
  it('renders the envelope, pt-BR labels and both sides', async () => {
    const md = renderBundle(await makeBundle('dm'));
    expect(md).toMatch(/^<CARD_BUNDLE>/);
    expect(md).toMatch(/<\/CARD_BUNDLE>$/);
    expect(md).toContain('fetched_at: 2026-08-10T18:00:00.000Z');
    expect(md).toContain('## Jira: QZ-252');
    expect(md).toContain('## Zendesk: chamado 16467');
    expect(md).toContain('- Resumo: [GERAL - APP2.0] Aplicativo travando ao tirar uma foto');
    expect(md).toContain('- Status: Em Teste');
    expect(md).toContain('- Responsável: Otavio Fernandes');
    expect(md).toContain('- Bloqueado: Yes');
    expect(md).toContain('- Controle de tempo: gasto 1d 4h, restante 0m');
    expect(md).toContain('- Development: 1 pull request — MERGED (atualizado 2026-08-10)');
    expect(md).toContain('### Root cause');
    expect(md).toContain('pseudo-crash');
    // jira-issue.json's fields carry customfield_99999 ("ruído"), a raw API field that is
    // deliberately absent from JIRA_FIELD_LABELS; the renderer only iterates that whitelist,
    // so it must never leak into the rendered bundle.
    expect(md).not.toContain('ruído');
  });

  it('renders comments with ids, authors and timestamps', async () => {
    const md = renderBundle(await makeBundle('dm'));
    expect(md).toContain('[comentário jira 41457] Otavio Fernandes — 2026-08-04T11:59:50.084-0300');
    expect(md).toContain('[comentário zendesk 902] [NOTA INTERNA] Suporte Agilean — 2026-08-04T12:00:00Z');
  });

  it('renders status history with durations', async () => {
    const md = renderBundle(await makeBundle('dm'));
    expect(md).toContain('### Histórico');
    expect(md).toContain('- 2026-08-04: status Backlog → Em Andamento (por Automation for Jira, 6d no estado seguinte)');
    expect(md).toContain('- 2026-08-04: responsável — → Otavio Fernandes (por Heitor Alves)');
  });

  it('computes the open-status duration from fetchedAt, not the wall clock', async () => {
    const md = renderBundle(await makeBundle('dm'));
    expect(md).toContain('- 2026-08-10: status Em Andamento → Em Teste (por Automation for Jira, há 0d neste estado)');
    expect(md).toBe(renderBundle(await makeBundle('dm')));
  });

  it('notes omitted internal notes on multiparty', async () => {
    const md = renderBundle(await makeBundle('multiparty'));
    expect(md).toContain('Notas internas do Zendesk foram omitidas neste contexto.');
    expect(md).not.toContain('[NOTA INTERNA]');
  });

  it('prints the status-history date from the same UTC instant the duration math uses', () => {
    // -0300 at 23:30 local is already 2026-08-05 UTC. The old `t.at.slice(0, 10)` printed the
    // wall-clock date encoded in the raw string (2026-08-04), while the duration math below
    // always parsed via `new Date(t.at)` (the UTC instant, 2026-08-05) -- so a late-evening
    // transition showed a date one day earlier than the duration it was paired with implied.
    const bundle: CardBundle = {
      fetchedAt: '2026-08-05T02:30:00.000Z',
      surface: 'dm',
      jira: {
        issueId: '1',
        issueKey: 'QZ-1',
        fields: { summary: 'teste' },
        comments: [],
        statusHistory: [{ field: 'status', from: 'A', to: 'B', at: '2026-08-04T23:30:00.000-0300', by: 'Automation' }],
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    };
    const md = renderBundle(bundle);
    expect(md).toContain('- 2026-08-05: status A → B (por Automation, há 0d neste estado)');
    expect(md).not.toContain('2026-08-04');
  });

  it('renders parent as KEY — summary, renders ADF fields not tagged rich, and skips empty strings', () => {
    const bundle: CardBundle = {
      fetchedAt: '2026-08-10T18:00:00.000Z',
      surface: 'dm',
      jira: {
        issueId: '1',
        issueKey: 'QZ-1',
        fields: {
          summary: 'teste',
          // parent shape verified on real cards: {id, key, fields: {summary}}
          parent: { id: '99', key: 'QZ-0', fields: { summary: 'Épico pai' } },
          // a custom field holding ADF that isn't in the hand-maintained rich-field list
          customfield_10656: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'link do problema' }] }] },
          resolution: '',
        },
        comments: [],
        statusHistory: [],
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    };
    const md = renderBundle(bundle);
    expect(md).toContain('- Item pai: QZ-0 — Épico pai');
    expect(md).toContain('### Problema\nlink do problema');
    expect(md).not.toContain('Resolução');
  });
});

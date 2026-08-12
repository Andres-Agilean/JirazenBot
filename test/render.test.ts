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

  it('renders the Jira attachment field as filenames with human-readable sizes, never content or URLs', () => {
    const bundle: CardBundle = {
      fetchedAt: '2026-08-11T18:00:00.000Z',
      surface: 'dm',
      jira: {
        issueId: '1',
        issueKey: 'QZ-252',
        fields: {
          summary: 'teste',
          attachment: [
            { filename: 'image-20260811-173359.png', size: 196259, content: 'https://api.atlassian.com/secret-download-url' },
            { filename: 'QZ-252.zip', size: 42450497, content: 'https://api.atlassian.com/other-secret-url' },
          ],
        },
        comments: [],
        statusHistory: [],
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    };
    const md = renderBundle(bundle);
    expect(md).toContain('- Anexos: image-20260811-173359.png (192 KB), QZ-252.zip (40,5 MB)');
    expect(md).not.toContain('secret-download-url');
    expect(md).not.toContain('secret-url');
  });

  it('omits the Anexos line entirely when the attachment array is empty', () => {
    const bundle: CardBundle = {
      fetchedAt: '2026-08-11T18:00:00.000Z',
      surface: 'dm',
      jira: { issueId: '1', issueKey: 'QZ-252', fields: { summary: 'teste', attachment: [] }, comments: [], statusHistory: [] },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    };
    expect(renderBundle(bundle)).not.toContain('Anexos');
  });

  it('collapses a Zendesk comment mirrored from Jira into one line when the Jira side is present and the key matches', () => {
    const bundle: CardBundle = {
      fetchedAt: '2026-08-11T18:00:00.000Z',
      surface: 'dm',
      jira: { issueId: '1', issueKey: 'QZ-252', fields: { summary: 'teste' }, comments: [], statusHistory: [] },
      zendesk: {
        ticketId: '16467', subject: 'assunto', status: 'open', priority: null,
        createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z',
        comments: [{
          id: 54276177045147,
          author: 'Administrador | Agilean',
          isPublic: false,
          createdAt: '2026-08-11T17:34:00Z',
          body: '[Jira] QZ-252 — André Marques:\n\n{panel}✅ Aprovado!{panel}',
          mirrorOf: { issueKey: 'QZ-252', author: 'André Marques' },
        }],
        internalNotesOmitted: false,
      },
      resolution: { via: 'zendesk_links', ambiguous: false },
      truncationNotes: [],
    };
    const md = renderBundle(bundle);
    expect(md).toContain(
      '[comentário zendesk 54276177045147] [espelhado do Jira QZ-252] André Marques — 2026-08-11T17:34:00Z (conteúdo idêntico ao comentário Jira correspondente)',
    );
    expect(md).not.toContain('{panel');
    expect(md).not.toContain('Aprovado!');
  });

  it('keeps a mirrored Zendesk comment, with wiki markup cleaned, when there is no matching Jira side', () => {
    const singleSided: CardBundle = {
      fetchedAt: '2026-08-11T18:00:00.000Z',
      surface: 'dm',
      zendesk: {
        ticketId: '16467', subject: 'assunto', status: 'open', priority: null,
        createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z',
        comments: [{
          id: 1, author: 'Administrador | Agilean', isPublic: false, createdAt: '2026-08-11T17:34:00Z',
          body: '[Jira] QZ-252 — André Marques:\n\n{panel}✅ Aprovado!{panel}',
          mirrorOf: { issueKey: 'QZ-252', author: 'André Marques' },
        }],
        internalNotesOmitted: false,
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    };
    const md = renderBundle(singleSided);
    expect(md).not.toContain('espelhado');
    expect(md).not.toContain('{panel');
    expect(md).toContain('✅ Aprovado!');

    // Same mirror body, but the Jira side present is a *different* issue key -- must not collapse.
    const mismatched: CardBundle = {
      ...singleSided,
      jira: { issueId: '9', issueKey: 'AGL-1', fields: { summary: 'outro card' }, comments: [], statusHistory: [] },
    };
    const md2 = renderBundle(mismatched);
    expect(md2).not.toContain('espelhado');
    expect(md2).toContain('✅ Aprovado!');
  });
});

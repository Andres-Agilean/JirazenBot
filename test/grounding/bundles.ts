import type { CardBundle } from '@/bundle/types.js';
import { olderCommentsOmittedNote } from '@/bundle/notes.js';

// Shared fetch timestamp for every bundle in this corpus, so a case's expectations about
// "how long has this been in state X" or "what does fetched_at say" stay derivable from a
// single constant instead of five copy-pasted literals that could drift apart.
const FETCHED_AT = '2026-08-12T13:00:00.000Z';

// Every ticket page size in this corpus is the real Zendesk/Jira COMMENT_PAGE_SIZE (see
// fetch/zendesk.ts, fetch/jira.ts) so the truncation note reads exactly as the real disclosure
// would, not an arbitrary round number.
const REAL_COMMENT_PAGE_SIZE = 100;

/**
 * Both sides, an automation-noisy comment thread, a mirrored comment, real status history.
 * Zendesk comment 90003 is this tenant's automated Jira->Zendesk mirror of Jira comment 70003
 * (see src/fetch/jiraMirror.ts): raw wiki-markup body carrying the literal "[Jira] KEY — Author:"
 * prefix, with `mirrorOf` set to what detectJiraMirror() would extract from it. Because this
 * bundle's jira.issueKey ('AGL-900') matches mirrorOf.issueKey, bundle/render.ts collapses it to
 * a one-line pointer instead of repeating Carla Nunes's validation comment a second time.
 */
export const richBundle: CardBundle = {
  fetchedAt: FETCHED_AT,
  surface: 'dm',
  jira: {
    issueId: '50001',
    issueKey: 'AGL-900',
    fields: {
      summary: '[NORTE CONSTRUTORA - AGL 2.0] RELATORIO DE AVANCO NAO CARREGA',
      status: { name: 'Em Teste' },
      issuetype: { name: 'Incident' },
      priority: { name: 'Major' },
      assignee: { displayName: 'Bruno Tavares' },
      customfield_10114: { displayName: 'Carla Nunes' },
      reporter: { displayName: 'Diego Alves' },
      created: '2026-08-03T09:12:00.000-0300',
      updated: '2026-08-11T16:40:00.000-0300',
      labels: ['jira_escalated'],
      customfield_10356: '20100',
      customfield_10322: { value: 'No' },
      timetracking: { timeSpent: '2d 3h', remainingEstimate: '0m' },
    },
    comments: [
      {
        id: '70001',
        author: 'Automation for Jira',
        createdAt: '2026-08-03T09:13:00.000-0300',
        body: 'Responsável iniciou a investigação do incidente',
      },
      {
        id: '70002',
        author: 'Bruno Tavares',
        createdAt: '2026-08-05T14:22:00.000-0300',
        body: 'Reproduzi em homologação. O relatório estoura timeout acima de 5000 linhas. Vou paginar a consulta.',
      },
      {
        id: '70003',
        author: 'Carla Nunes',
        createdAt: '2026-08-11T16:39:00.000-0300',
        body: 'Validado em homologação, 14 casos de teste executados, todos aprovados. Não testei em iOS físico.',
      },
    ],
    statusHistory: [
      { field: 'status', from: 'Backlog', to: 'Em Desenvolvimento', at: '2026-08-03T09:12:00.000-0300', by: 'Diego Alves' },
      { field: 'assignee', from: null, to: 'Bruno Tavares', at: '2026-08-03T09:12:30.000-0300', by: 'Diego Alves' },
      { field: 'status', from: 'Em Desenvolvimento', to: 'Em Teste', at: '2026-08-10T11:00:00.000-0300', by: 'Bruno Tavares' },
    ],
  },
  zendesk: {
    ticketId: '20100',
    subject: '[NORTE CONSTRUTORA - AGL 2.0] RELATORIO DE AVANCO NAO CARREGA',
    status: 'hold',
    priority: 'high',
    createdAt: '2026-08-03T12:05:00Z',
    updatedAt: '2026-08-11T19:41:00Z',
    comments: [
      {
        id: 90001,
        author: 'Atendimento | Suporte',
        isPublic: false,
        createdAt: '2026-08-03T12:05:00Z',
        body: '- Organização: NORTE CONSTRUTORA\n- Interface: ( X ) Portal\n- Versão: 2.4.1\n- Evidência: relatório de avanço não carrega, fica girando',
      },
      {
        id: 90002,
        author: 'Atendimento | Suporte',
        isPublic: true,
        createdAt: '2026-08-04T10:00:00Z',
        body: 'Olá! Recebemos seu chamado e nosso time já está analisando.',
      },
      {
        id: 90003,
        author: 'Integração Jira',
        isPublic: false,
        createdAt: '2026-08-11T16:40:00Z',
        // Verbatim as this tenant's mirror integration writes it (fetch/jiraMirror.ts): the
        // Jira comment's own wiki-markup text, pasted behind a "[Jira] KEY — Author:" prefix.
        body: '[Jira] AGL-900 — Carla Nunes: Validado em homologação, 14 casos de teste executados, todos aprovados. Não testei em iOS físico.',
        mirrorOf: { issueKey: 'AGL-900', author: 'Carla Nunes' },
      },
    ],
    internalNotesOmitted: false,
  },
  resolution: { via: 'jira_zendesk_id_field', ambiguous: false },
  truncationNotes: [],
};

/** A same-day escalation: almost every optional field null, no comments, no history yet. */
export const sparseBundle: CardBundle = {
  fetchedAt: FETCHED_AT,
  surface: 'dm',
  jira: {
    issueId: '50002',
    issueKey: 'AGL-901',
    fields: {
      summary: '[VALE VERDE - AGL 2.0] Dúvida sobre exportação de planilha',
      status: { name: 'Pronto para Delivery' },
      issuetype: { name: 'Incident' },
      priority: { name: 'Medium' },
      reporter: { displayName: 'Diego Alves' },
      created: '2026-08-12T08:30:00.000-0300',
      updated: '2026-08-12T08:30:00.000-0300',
      labels: ['jira_escalated'],
      customfield_10356: '20101',
    },
    comments: [],
    statusHistory: [],
  },
  zendesk: {
    ticketId: '20101',
    subject: '[VALE VERDE - AGL 2.0] Dúvida sobre exportação de planilha',
    status: 'open',
    priority: null,
    createdAt: '2026-08-12T11:29:00Z',
    updatedAt: '2026-08-12T11:31:00Z',
    comments: [
      {
        id: 90010,
        author: 'Atendimento | Suporte',
        isPublic: false,
        createdAt: '2026-08-12T11:29:00Z',
        body: '- Organização: VALE VERDE\n- Interface: ( X ) Excel\n- Evidência: cliente quer saber se dá para exportar o cronograma completo',
      },
    ],
    internalNotesOmitted: false,
  },
  resolution: { via: 'jira_zendesk_id_field', ambiguous: false },
  truncationNotes: [],
};

/** Jira side only: no Zendesk counterpart was found at all. */
export const jiraOnlyBundle: CardBundle = {
  fetchedAt: FETCHED_AT,
  surface: 'dm',
  jira: {
    issueId: '50003',
    issueKey: 'QZ-410',
    fields: {
      summary: '[GERAL - APP2.0] Sincronização de fotos falha em rede lenta',
      status: { name: 'Em Desenvolvimento' },
      issuetype: { name: 'Bug' },
      priority: { name: 'Major' },
      assignee: { displayName: 'Bruno Tavares' },
      created: '2026-08-06T10:00:00.000-0300',
      updated: '2026-08-11T10:00:00.000-0300',
    },
    comments: [
      {
        id: '70010',
        author: 'Bruno Tavares',
        createdAt: '2026-08-07T09:00:00.000-0300',
        body: 'Retry exponencial implementado. Falta validar em 3G.',
      },
    ],
    statusHistory: [
      { field: 'status', from: 'Backlog', to: 'Em Desenvolvimento', at: '2026-08-06T10:00:00.000-0300', by: 'Bruno Tavares' },
    ],
  },
  resolution: { via: 'direct_only', ambiguous: false },
  truncationNotes: [],
};

/** Comment history hit the API page limit, so the bundle carries a disclosure note. */
export const truncatedBundle: CardBundle = {
  ...richBundle,
  jira: { ...richBundle.jira!, issueKey: 'AGL-902', issueId: '50004' },
  truncationNotes: [olderCommentsOmittedNote('Zendesk', REAL_COMMENT_PAGE_SIZE)],
};

/** Channel surface: internal Zendesk notes were dropped before the bundle was built. */
export const channelBundle: CardBundle = {
  ...richBundle,
  surface: 'multiparty',
  zendesk: {
    ...richBundle.zendesk!,
    comments: richBundle.zendesk!.comments.filter((c) => c.isPublic),
    internalNotesOmitted: true,
  },
};

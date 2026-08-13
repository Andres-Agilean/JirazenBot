import type { Config } from '@/config.js';
import type { JiraIssueRef } from '@/resolve/types.js';
import { NotFoundError, httpStatusError } from './errors.js';

// Jira comments API page size. Also the threshold above which older comments are omitted
// (see olderCommentsOmitted below) -- keep the query string and that comparison derived from
// this single constant rather than repeating the literal.
export const COMMENT_PAGE_SIZE = 100;

export interface JiraFieldMeta {
  label: string;
  /**
   * How this field's value renders, beyond a plain "- label: value" line. This is the single
   * place a reader should need to check to learn how a given field id renders -- render.ts
   * dispatches on `kind` rather than switching on field ids directly.
   * - 'rich': a known ADF document, always rendered as its own markdown section via
   *   adfToMarkdown. Fields without this tag still render as ADF if the value looks like an
   *   ADF doc at runtime (see bundle/render.ts's renderBundle loop, which sniffs via isAdfDoc)
   *   -- this tag only marks *known* rich fields so they skip that sniff; it is not an
   *   allowlist for ADF rendering.
   * - 'issueRef': a Jira issue reference shape ({ key, fields: { summary } }), rendered as
   *   "KEY — summary" (see renderParent in bundle/render.ts). Used by `parent`.
   * - 'development': the customfield_10000 PR-status blob, condensed via condenseDevelopment.
   * - 'timeTracking': the `timetracking` object, rendered as "estimado X, gasto Y, restante Z".
   * - 'attachments': the `attachment` field (array of {filename, size, ...}), rendered as a
   *   single "- Anexos: filename (size), ..." line -- filenames and human-readable sizes only,
   *   never content and never the download URLs the API also returns.
   * Fields with no `kind` render via renderGeneric: scalars, arrays, or the first populated
   * displayName/name/value/text on an object.
   */
  kind?: 'rich' | 'issueRef' | 'development' | 'timeTracking' | 'attachments';
}

// Insertion order doubles as render order in bundle/render.ts.
export const JIRA_FIELD_LABELS: Record<string, JiraFieldMeta> = {
  summary: { label: 'Resumo' },
  status: { label: 'Status' },
  issuetype: { label: 'Tipo' },
  priority: { label: 'Prioridade' },
  assignee: { label: 'Responsável' },
  customfield_10114: { label: 'Tester' },
  reporter: { label: 'Relator' },
  created: { label: 'Criado em' },
  updated: { label: 'Atualizado em' },
  duedate: { label: 'Data limite' },
  resolution: { label: 'Resolução' },
  resolutiondate: { label: 'Resolvido em' },
  labels: { label: 'Etiquetas' },
  components: { label: 'Componentes' },
  fixVersions: { label: 'Versões de correção' },
  parent: { label: 'Item pai', kind: 'issueRef' },
  customfield_10010: { label: 'Sprint' },
  customfield_10356: { label: 'Zendesk ID' },
  customfield_10389: { label: 'Tipo de incidente' },
  customfield_10322: { label: 'Bloqueado' },
  customfield_10321: { label: 'Correção Definitiva' },
  customfield_10622: { label: 'Classificação QA' },
  customfield_10756: { label: 'Origem do Defeito' },
  customfield_10210: { label: 'Quantidade de vezes "Reprovado"' },
  customfield_10319: { label: 'Feature afetada' },
  customfield_10318: { label: 'Motivo de contato' },
  customfield_10656: { label: 'Problema' },
  customfield_10284: { label: 'Critérios de Aceite', kind: 'rich' },
  customfield_10206: { label: 'Zendesk Status' },
  customfield_10207: { label: 'Prioridade Zendesk' },
  customfield_10106: { label: 'Clientes' },
  timetracking: { label: 'Controle de tempo', kind: 'timeTracking' },
  timeoriginalestimate: { label: 'Estimativa original' },
  aggregatetimespent: { label: 'Σ Tempo gasto' },
  customfield_10000: { label: 'Development', kind: 'development' },
  attachment: { label: 'Anexos', kind: 'attachments' },
  description: { label: 'Descrição', kind: 'rich' },
  customfield_10070: { label: 'Root cause', kind: 'rich' },
  customfield_10071: { label: 'Workaround', kind: 'rich' },
  customfield_10320: { label: 'Diagnóstico', kind: 'rich' },
};

export interface JiraComment { id: string; author: string; createdAt: string; body: unknown }
export interface RawChangelogEntry { at: string; by: string; items: { field: string; fromString: string | null; toString: string | null }[] }
export interface JiraIssue {
  issueId: string;
  issueKey: string;
  fields: Record<string, unknown>;
  comments: JiraComment[];
  changelog: RawChangelogEntry[];
  olderCommentsOmitted?: boolean;
}

export class JiraClient {
  constructor(private cfg: Config, private fetchFn: typeof fetch = fetch) {}

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.cfg.atlassianEmail}:${this.cfg.atlassianToken}`).toString('base64');
    return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
  }

  private async get(path: string): Promise<unknown> {
    // jiraApiBaseUrl (the api.atlassian.com gateway), never cfg.siteUrl (display-only deep-link
    // host) -- see the Config.jiraApiBaseUrl/siteUrl comment in config.ts.
    const res = await this.fetchFn(`${this.cfg.jiraApiBaseUrl}${path}`, { headers: this.headers() });
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw httpStatusError('Jira', res.status, path);
    return res.json();
  }

  async getIssue(idOrKey: string): Promise<JiraIssue> {
    // Always request/retain the configured Zendesk-id field, even if it isn't one of the ids
    // JIRA_FIELD_LABELS happens to hardcode. JIRA_ZENDESK_ID_FIELD (config.ts) is a per-tenant
    // custom field id, and JiraFieldStrategy.jiraToZendesk (resolve/strategies.ts) reads
    // fields[cfg.zendeskIdField] directly -- if that key were only ever populated because it
    // happened to match a table entry, an operator pointing this bot at a different Jira Cloud
    // instance (different custom field ids) would get an `undefined` lookup and the resolver
    // strategy would silently stop matching, with no error. Requesting it unconditionally here
    // removes that desync at the source instead of merely detecting it elsewhere.
    const requestedFields = new Set<string>([...Object.keys(JIRA_FIELD_LABELS), this.cfg.zendeskIdField]);
    const fieldList = [...requestedFields].join(',');
    const raw = (await this.get(
      `/rest/api/3/issue/${idOrKey}?expand=changelog&fields=${fieldList}`,
    )) as {
      id: string; key: string;
      fields: Record<string, unknown>;
      changelog?: { histories?: { created: string; author?: { displayName?: string }; items?: { field: string; fromString: string | null; toString: string | null }[] }[] };
    };

    const fields: Record<string, unknown> = {};
    for (const k of requestedFields) {
      if (raw.fields[k] !== undefined) fields[k] = raw.fields[k];
    }

    // orderBy=-created (newest first): this is a Q&A bot whose most common question is "what's
    // the latest?", so when a card has more than 100 comments we must keep the newest 100, not
    // the oldest. We do NOT trust that Jira actually honored the ordering -- sort client-side by
    // the comment's own `created` timestamp instead of blindly reversing, so a server that ignores
    // orderBy can never silently invert the result into descending order.
    const commentsRaw = (await this.get(
      `/rest/api/3/issue/${idOrKey}/comment?maxResults=${COMMENT_PAGE_SIZE}&orderBy=-created`,
    )) as { comments: { id: string; author?: { displayName?: string }; created: string; body: unknown }[]; total?: number };

    const changelog = (raw.changelog?.histories ?? [])
      .map((h) => ({
        at: h.created,
        by: h.author?.displayName ?? 'desconhecido',
        items: h.items ?? [],
      }))
      .sort((a, b) => a.at.localeCompare(b.at));

    const olderCommentsOmitted = typeof commentsRaw.total === 'number' && commentsRaw.total > commentsRaw.comments.length;

    return {
      issueId: raw.id,
      issueKey: raw.key,
      fields,
      comments: [...commentsRaw.comments]
        .sort((a, b) => a.created.localeCompare(b.created))
        .map((c) => ({
          id: c.id,
          author: c.author?.displayName ?? 'desconhecido',
          createdAt: c.created,
          body: c.body,
        })),
      changelog,
      olderCommentsOmitted,
    };
  }

  async searchByZendeskId(ticketId: string): Promise<JiraIssueRef[]> {
    const cfNumber = this.cfg.zendeskIdField.replace('customfield_', '');
    const jql = `cf[${cfNumber}] ~ "${ticketId}" AND project in (${this.cfg.allowedProjects.join(',')})`;
    const raw = (await this.get(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=10`,
    )) as { issues?: { id: string; key: string }[] };
    return (raw.issues ?? []).map((i) => ({ issueId: i.id, issueKey: i.key }));
  }
}

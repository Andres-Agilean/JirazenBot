import type { Config } from '../config.js';
import type { JiraIssueRef } from '../resolve/types.js';

// Jira comments API page size. Also the threshold above which older comments are omitted
// (see olderCommentsOmitted below) -- keep the query string and that comparison derived from
// this single constant rather than repeating the literal.
export const COMMENT_PAGE_SIZE = 100;

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Não encontrado: ${what}`);
    this.name = 'NotFoundError';
  }
}

export interface JiraFieldMeta {
  label: string;
  /** 'rich' fields are known ADF documents and always render as their own markdown section.
   * Fields without this tag still render as ADF if the value looks like an ADF doc at
   * runtime (see bundle/render.ts renderGeneric) -- this tag only controls *known* rich fields
   * so they don't need runtime sniffing, not an allowlist for ADF rendering. */
  kind?: 'rich';
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
  parent: { label: 'Item pai' },
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
  timetracking: { label: 'Controle de tempo' },
  timeoriginalestimate: { label: 'Estimativa original' },
  aggregatetimespent: { label: 'Σ Tempo gasto' },
  customfield_10000: { label: 'Development' },
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
    const res = await this.fetchFn(`${this.cfg.siteUrl}${path}`, { headers: this.headers() });
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new Error(`Jira ${res.status} em ${path}`);
    return res.json();
  }

  async getIssue(idOrKey: string): Promise<JiraIssue> {
    const fieldList = Object.keys(JIRA_FIELD_LABELS).join(',');
    const raw = (await this.get(
      `/rest/api/3/issue/${idOrKey}?expand=changelog&fields=${fieldList}`,
    )) as {
      id: string; key: string;
      fields: Record<string, unknown>;
      changelog?: { histories?: { created: string; author?: { displayName?: string }; items?: { field: string; fromString: string | null; toString: string | null }[] }[] };
    };

    const fields: Record<string, unknown> = {};
    for (const k of Object.keys(JIRA_FIELD_LABELS)) {
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

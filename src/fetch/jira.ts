import type { Config } from '../config.js';
import type { JiraIssueRef } from '../resolve/types.js';

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Não encontrado: ${what}`);
    this.name = 'NotFoundError';
  }
}

// Insertion order doubles as render order in bundle/render.ts.
export const JIRA_FIELD_LABELS: Record<string, string> = {
  summary: 'Resumo',
  status: 'Status',
  issuetype: 'Tipo',
  priority: 'Prioridade',
  assignee: 'Responsável',
  customfield_10114: 'Tester',
  reporter: 'Relator',
  created: 'Criado em',
  updated: 'Atualizado em',
  duedate: 'Data limite',
  resolution: 'Resolução',
  resolutiondate: 'Resolvido em',
  labels: 'Etiquetas',
  components: 'Componentes',
  fixVersions: 'Versões de correção',
  parent: 'Item pai',
  customfield_10010: 'Sprint',
  customfield_10356: 'Zendesk ID',
  customfield_10389: 'Tipo de incidente',
  customfield_10322: 'Bloqueado',
  customfield_10321: 'Correção Definitiva',
  customfield_10622: 'Classificação QA',
  customfield_10756: 'Origem do Defeito',
  customfield_10210: 'Quantidade de vezes "Reprovado"',
  customfield_10319: 'Feature afetada',
  customfield_10318: 'Motivo de contato',
  customfield_10656: 'Problema',
  customfield_10284: 'Critérios de Aceite',
  customfield_10206: 'Zendesk Status',
  customfield_10207: 'Prioridade Zendesk',
  customfield_10106: 'Clientes',
  timetracking: 'Controle de tempo',
  timeoriginalestimate: 'Estimativa original',
  aggregatetimespent: 'Σ Tempo gasto',
  customfield_10000: 'Development',
  description: 'Descrição',
  customfield_10070: 'Root cause',
  customfield_10071: 'Workaround',
  customfield_10320: 'Diagnóstico',
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
    // the oldest. We reverse below so JiraIssue.comments stays ascending for existing consumers.
    const commentsRaw = (await this.get(
      `/rest/api/3/issue/${idOrKey}/comment?maxResults=100&orderBy=-created`,
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
      comments: [...commentsRaw.comments].reverse().map((c) => ({
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

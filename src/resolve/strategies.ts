import type { Config } from '@/config.js';
import type { JiraIssueRef, ResolverVia } from './types.js';
import type { JiraClient } from '@/fetch/jira.js';

export interface ResolverStrategy {
  name: ResolverVia;
  jiraToZendesk(issue: JiraIssueRef): Promise<string[]>;
  zendeskToJira(ticketId: string): Promise<JiraIssueRef[]>;
}

interface LinksResponse {
  links?: { issue_id: string | number; issue_key: string; ticket_id: string | number }[];
}

export class ZendeskLinksStrategy implements ResolverStrategy {
  readonly name = 'zendesk_links' as const;
  constructor(private cfg: Config, private fetchFn: typeof fetch = fetch) {}

  private async getLinks(query: string): Promise<NonNullable<LinksResponse['links']>> {
    const url = `https://${this.cfg.zendeskSubdomain}.zendesk.com/api/v2/integrations/jira/${this.cfg.zendeskJiraExternalId}/links?${query}`;
    const basic = Buffer.from(`${this.cfg.zendeskEmail}/token:${this.cfg.zendeskToken}`).toString('base64');
    const res = await this.fetchFn(url, { headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Zendesk links API ${res.status}`);
    return ((await res.json()) as LinksResponse).links ?? [];
  }

  async jiraToZendesk(issue: JiraIssueRef): Promise<string[]> {
    const links = await this.getLinks(`issue_id=${issue.issueId}`);
    return links.map((l) => String(l.ticket_id));
  }

  async zendeskToJira(ticketId: string): Promise<JiraIssueRef[]> {
    const links = await this.getLinks(`ticket_id=${ticketId}`);
    return links.map((l) => ({ issueId: String(l.issue_id), issueKey: l.issue_key }));
  }
}

export class JiraFieldStrategy implements ResolverStrategy {
  readonly name = 'jira_zendesk_id_field' as const;
  constructor(private jira: JiraClient, private cfg: Config) {}

  async jiraToZendesk(issue: JiraIssueRef): Promise<string[]> {
    const full = await this.jira.getIssue(issue.issueId);
    const value = full.fields[this.cfg.zendeskIdField];
    return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : [];
  }

  async zendeskToJira(ticketId: string): Promise<JiraIssueRef[]> {
    return this.jira.searchByZendeskId(ticketId);
  }
}

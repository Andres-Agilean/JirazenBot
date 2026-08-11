export type ResolverVia = 'zendesk_links' | 'jira_zendesk_id_field';

export interface JiraIssueRef {
  issueId: string;
  issueKey: string;
}

export type CardRef =
  | { system: 'jira'; issueKey: string; explicit: boolean }
  | { system: 'zendesk'; ticketId: string; explicit: boolean };

import type { JiraComment } from '../fetch/jira.js';
import type { Transition } from '../fetch/condense.js';
import type { ZendeskComment } from '../fetch/zendesk.js';
import type { ResolverVia } from '../resolve/types.js';

export type Surface = 'dm' | 'multiparty';

export interface CardBundle {
  fetchedAt: string;
  surface: Surface;
  jira?: {
    issueId: string;
    issueKey: string;
    fields: Record<string, unknown>;
    comments: JiraComment[];
    statusHistory: Transition[];
  };
  zendesk?: {
    ticketId: string;
    subject: string;
    status: string;
    priority: string | null;
    createdAt: string;
    updatedAt: string;
    comments: ZendeskComment[];
    internalNotesOmitted: boolean;
  };
  resolution: { via: ResolverVia | 'direct_only'; ambiguous: boolean };
  truncationNotes: string[];
}

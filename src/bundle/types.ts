import type { JiraComment } from '../fetch/jira.js';
import type { Transition } from '../fetch/condense.js';
import type { ZendeskComment } from '../fetch/zendesk.js';
import type { ResolverVia } from '../resolve/types.js';

// Single source of truth for the allowed --surface values: the Surface type is derived from
// this array instead of a separately hand-maintained union, so validating a runtime string
// against SURFACES can never drift out of sync with the type.
export const SURFACES = ['dm', 'multiparty'] as const;
export type Surface = (typeof SURFACES)[number];

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

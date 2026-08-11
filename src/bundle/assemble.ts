import type { CardRef } from '../resolve/types.js';
import type { Resolver } from '../resolve/resolver.js';
import { JiraClient, NotFoundError, type JiraIssue } from '../fetch/jira.js';
import type { ZendeskClient, ZendeskTicket } from '../fetch/zendesk.js';
import { condenseChangelog } from '../fetch/condense.js';
import { applyBudget } from './budget.js';
import type { CardBundle, Surface } from './types.js';

export interface AssembleDeps { jira: JiraClient; zendesk: ZendeskClient; resolver: Resolver }

export type AssembleResult =
  | { status: 'ok'; bundle: CardBundle }
  | { status: 'ambiguous'; side: 'jira' | 'zendesk'; candidates: string[] }
  | { status: 'not_found'; message: string };

export async function assembleBundle(
  ref: CardRef,
  deps: AssembleDeps,
  surface: Surface,
  now: () => Date = () => new Date(),
  budgetTokens = 25000,
): Promise<AssembleResult> {
  let jiraIssue: JiraIssue | undefined;
  let ticket: ZendeskTicket | undefined;
  let via: CardBundle['resolution']['via'] = 'direct_only';

  try {
    if (ref.system === 'jira') {
      jiraIssue = await deps.jira.getIssue(ref.issueKey);
      const lookup = await deps.resolver.jiraToZendesk({ issueId: jiraIssue.issueId, issueKey: jiraIssue.issueKey });
      if (lookup) {
        if (lookup.hits.length > 1) return { status: 'ambiguous', side: 'zendesk', candidates: lookup.hits };
        via = lookup.via;
        ticket = await fetchTicketSafe(deps.zendesk, lookup.hits[0]);
      }
    } else {
      ticket = await deps.zendesk.getTicket(ref.ticketId);
      const lookup = await deps.resolver.zendeskToJira(ref.ticketId);
      if (lookup) {
        if (lookup.hits.length > 1) return { status: 'ambiguous', side: 'jira', candidates: lookup.hits.map((h) => h.issueKey) };
        via = lookup.via;
        jiraIssue = await fetchIssueSafe(deps.jira, lookup.hits[0].issueId);
      }
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      const label = ref.system === 'jira' ? `o card ${ref.issueKey}` : `o chamado ${ref.ticketId}`;
      return { status: 'not_found', message: `Não encontrei ${label}.` };
    }
    throw err;
  }

  const bundle: CardBundle = {
    fetchedAt: now().toISOString(),
    surface,
    resolution: { via, ambiguous: false },
    truncationNotes: [],
  };

  if (jiraIssue) {
    bundle.jira = {
      issueId: jiraIssue.issueId,
      issueKey: jiraIssue.issueKey,
      fields: jiraIssue.fields,
      comments: jiraIssue.comments,
      statusHistory: condenseChangelog(jiraIssue.changelog),
    };
  }

  if (ticket) {
    const omit = surface === 'multiparty';
    bundle.zendesk = {
      ticketId: ticket.ticketId,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      comments: omit ? ticket.comments.filter((c) => c.isPublic) : ticket.comments,
      internalNotesOmitted: omit,
    };
  }

  return { status: 'ok', bundle: applyBudget(bundle, budgetTokens) };
}

// Counterpart fetch failures degrade to a single-sided bundle instead of failing the request.
async function fetchTicketSafe(zd: ZendeskClient, id: string): Promise<ZendeskTicket | undefined> {
  try {
    return await zd.getTicket(id);
  } catch {
    return undefined;
  }
}

async function fetchIssueSafe(jira: JiraClient, id: string): Promise<JiraIssue | undefined> {
  try {
    return await jira.getIssue(id);
  } catch {
    return undefined;
  }
}

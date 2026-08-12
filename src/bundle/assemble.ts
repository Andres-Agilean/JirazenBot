import type { CardRef } from '../resolve/types.js';
import type { Resolver } from '../resolve/resolver.js';
import { JiraClient, NotFoundError, COMMENT_PAGE_SIZE as JIRA_COMMENT_PAGE_SIZE, type JiraIssue } from '../fetch/jira.js';
import { COMMENT_PAGE_SIZE as ZENDESK_COMMENT_PAGE_SIZE, type ZendeskClient, type ZendeskTicket } from '../fetch/zendesk.js';
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
  // Set when the resolver found a counterpart reference but fetching it failed (404 or
  // otherwise) -- without this, a missing counterpart is indistinguishable from "no
  // counterpart exists" once `via` still names the winning resolver strategy.
  let counterpartUnreadableNote: string | undefined;

  try {
    if (ref.system === 'jira') {
      jiraIssue = await deps.jira.getIssue(ref.issueKey);
      const lookup = await deps.resolver.jiraToZendesk({ issueId: jiraIssue.issueId, issueKey: jiraIssue.issueKey });
      if (lookup) {
        if (lookup.hits.length > 1) return { status: 'ambiguous', side: 'zendesk', candidates: lookup.hits };
        via = lookup.via;
        const counterpartTicketId = lookup.hits[0];
        ticket = await fetchTicketSafe(deps.zendesk, counterpartTicketId);
        if (!ticket) {
          counterpartUnreadableNote = `contraparte Zendesk ${counterpartTicketId} foi encontrada mas não pôde ser carregada`;
        }
      }
    } else {
      ticket = await deps.zendesk.getTicket(ref.ticketId);
      const lookup = await deps.resolver.zendeskToJira(ref.ticketId);
      if (lookup) {
        if (lookup.hits.length > 1) return { status: 'ambiguous', side: 'jira', candidates: lookup.hits.map((h) => h.issueKey) };
        via = lookup.via;
        const counterpartIssue = lookup.hits[0];
        jiraIssue = await fetchIssueSafe(deps.jira, counterpartIssue.issueId);
        if (!jiraIssue) {
          counterpartUnreadableNote = `contraparte Jira ${counterpartIssue.issueKey} foi encontrada mas não pôde ser carregada`;
        }
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

  if (jiraIssue?.olderCommentsOmitted) {
    bundle.truncationNotes.push(`comentários mais antigos do Jira não foram carregados (limite de ${JIRA_COMMENT_PAGE_SIZE})`);
  }
  if (ticket?.olderCommentsOmitted) {
    bundle.truncationNotes.push(`comentários mais antigos do Zendesk não foram carregados (limite de ${ZENDESK_COMMENT_PAGE_SIZE})`);
  }
  if (counterpartUnreadableNote) {
    bundle.truncationNotes.push(counterpartUnreadableNote);
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

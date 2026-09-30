import { CARD_FETCH_CAP } from '@/fetch/zendesk.js';
import type { ZendeskOrg, ZendeskTicketSummary } from '@/fetch/zendesk.js';
import type { JiraCardSummary } from '@/fetch/jira.js';
import type { CardRef } from '@/resolve/types.js';
import { normalizeText } from '@/text/normalize.js';

export interface CardCandidate {
  ref: CardRef; // explicit:true — selecting must always rebind
  label: string; // 'AGL-900' or 'chamado 16467'
  summary: string;
  status: string;
  updatedAt: string;
}

export type SearchOutcome =
  | { kind: 'orgs'; name: string; orgs: ZendeskOrg[] }
  | { kind: 'bind'; ref: CardRef }
  | { kind: 'cards'; name: string; cards: CardCandidate[]; total: number }
  | { kind: 'none'; name: string };

export interface SearchDeps {
  searchOrganizations(name: string): Promise<ZendeskOrg[]>;
  openTicketsForOrganization(orgId: number): Promise<ZendeskTicketSummary[]>;
  searchActiveByText(text: string): Promise<JiraCardSummary[]>;
  searchByZendeskIds(ids: string[]): Promise<Array<JiraCardSummary & { zendeskId: string }>>;
}

/** Spec §6a: identical repeated searches within this window hit no vendor. */
export const SEARCH_CACHE_TTL_MS = 60_000;

const jiraCandidate = (c: JiraCardSummary): CardCandidate => ({
  ref: { system: 'jira', issueKey: c.issueKey, explicit: true },
  label: c.issueKey,
  summary: c.summary,
  status: c.status,
  updatedAt: c.updatedAt,
});

const zendeskCandidate = (t: ZendeskTicketSummary): CardCandidate => ({
  ref: { system: 'zendesk', ticketId: t.ticketId, explicit: true },
  label: `chamado ${t.ticketId}`,
  summary: t.subject,
  status: t.status,
  updatedAt: t.updatedAt,
});

// ISO-8601 UTC strings sort lexicographically; newest first.
const newestFirst = (a: CardCandidate, b: CardCandidate): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;

function cardsOutcome(name: string, candidates: CardCandidate[]): SearchOutcome {
  if (candidates.length === 0) return { kind: 'none', name };
  const sorted = [...candidates].sort(newestFirst);
  return { kind: 'cards', name, cards: sorted.slice(0, CARD_FETCH_CAP), total: sorted.length };
}

/** Map an organization's open tickets to Jira in ONE call; unmapped tickets keep a Zendesk ref. */
async function candidatesForTickets(
  tickets: ZendeskTicketSummary[],
  deps: SearchDeps,
): Promise<CardCandidate[]> {
  const mapped = await deps.searchByZendeskIds(tickets.slice(0, CARD_FETCH_CAP).map((t) => t.ticketId));
  const byZendeskId = new Map(mapped.map((m) => [m.zendeskId, m]));
  return tickets.map((t) => {
    const jira = byZendeskId.get(t.ticketId);
    return jira ? jiraCandidate(jira) : zendeskCandidate(t);
  });
}

export async function searchPortfolio(name: string, deps: SearchDeps): Promise<SearchOutcome> {
  const query = name.trim();
  if (!query) return { kind: 'none', name: query };

  const orgs = await deps.searchOrganizations(query);
  if (orgs.length > 1) return { kind: 'orgs', name: query, orgs };

  if (orgs.length === 1) {
    const tickets = await deps.openTicketsForOrganization(orgs[0].id);
    if (tickets.length === 1) return { kind: 'bind', ref: zendeskCandidate(tickets[0]).ref };
    if (tickets.length > 1) return cardsOutcome(query, await candidatesForTickets(tickets, deps));
    // zero open tickets: fall through to Jira text search
  }

  // Text search never silently binds, even for a single hit (spec §4).
  return cardsOutcome(query, (await deps.searchActiveByText(query)).map(jiraCandidate));
}

export function createSearchCache(now: () => number = Date.now): {
  run(name: string, deps: SearchDeps): Promise<SearchOutcome>;
} {
  const memo = new Map<string, { at: number; outcome: SearchOutcome }>();
  return {
    async run(name, deps) {
      const key = normalizeText(name);
      const hit = memo.get(key);
      if (hit && now() - hit.at <= SEARCH_CACHE_TTL_MS) return hit.outcome;
      const outcome = await searchPortfolio(name, deps); // a throw skips the set: failures never cached
      memo.set(key, { at: now(), outcome });
      return outcome;
    },
  };
}

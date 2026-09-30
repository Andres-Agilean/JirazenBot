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
  | { kind: 'bind'; candidate: CardCandidate }
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

/** The id a candidate is selected by: issue key or ticket id. */
export const candidateId = (c: Pick<CardCandidate, 'ref'>): string =>
  c.ref.system === 'jira' ? c.ref.issueKey : c.ref.ticketId;

/** Identity of the card a candidate points at; two candidates with the same key are one card. */
export const candidateKey = (c: Pick<CardCandidate, 'ref'>): string => `${c.ref.system}:${candidateId(c)}`;

/** Keeps the first candidate per card, so callers pass newest-first to keep the newest duplicate. */
export function dedupeCandidates<T extends Pick<CardCandidate, 'ref'>>(candidates: T[]): T[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = candidateKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

// Jira returns local-offset timestamps (-0300), Zendesk returns Z; string order is wrong across
// the two, so compare instants. Unparseable values count as 0 (oldest). Newest first.
const instant = (s: string): number => {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? 0 : ms;
};
const newestFirst = (a: CardCandidate, b: CardCandidate): number =>
  instant(b.updatedAt) - instant(a.updatedAt);

function cardsOutcome(name: string, candidates: CardCandidate[]): SearchOutcome {
  if (candidates.length === 0) return { kind: 'none', name };
  // Several tickets can map to one Jira card; sorted newest-first, dedupe keeps the newest.
  const sorted = dedupeCandidates([...candidates].sort(newestFirst));
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

  const found = await deps.searchOrganizations(query);
  // An org named exactly like the query wins over longer names that merely share its prefix;
  // otherwise `buscar <that exact name>` would return the same choice list forever.
  const exact = found.filter((o) => normalizeText(o.name) === normalizeText(query));
  const orgs = exact.length === 1 ? exact : found;
  if (orgs.length > 1) return { kind: 'orgs', name: query, orgs };

  if (orgs.length === 1) {
    const tickets = await deps.openTicketsForOrganization(orgs[0].id);
    // Deliberate: a single ticket binds with the ZENDESK ref and skips searchByZendeskIds.
    // loadCardBundle resolves the Jira counterpart at bind time anyway, and skipping the
    // mapping keeps this path at 2 GETs.
    if (tickets.length === 1) return { kind: 'bind', candidate: zendeskCandidate(tickets[0]) };
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
      for (const [k, v] of memo) if (now() - v.at > SEARCH_CACHE_TTL_MS) memo.delete(k);
      memo.set(key, { at: now(), outcome });
      return outcome;
    },
  };
}

import type { CardCandidate } from './search.js';

/** Assignee bucket for Jira cards nobody owns and for Zendesk tickets (no assignee lookup). */
export const NO_ASSIGNEE = 'sem responsável';

/** What a distribution groups by. */
export type DistributionDimension = 'status' | 'assignee';

export interface Bucket {
  key: string;
  items: CardCandidate[];
}

/** Group `cards` by `keyOf`, count desc then label asc, so equal counts never reorder between renders. */
function groupBy(cards: CardCandidate[], keyOf: (c: CardCandidate) => string): Bucket[] {
  const groups = new Map<string, CardCandidate[]>();
  for (const c of cards) {
    const key = keyOf(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups]
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}

/** Status buckets of one system's cards (statuses are not comparable across Jira and Zendesk). */
export const statusBuckets = (cards: CardCandidate[], system: CardCandidate['ref']['system']): Bucket[] =>
  groupBy(cards.filter((c) => c.ref.system === system), (c) => c.status);

/** Assignee buckets across all cards; absent assignees fall into NO_ASSIGNEE. */
export const assigneeBuckets = (cards: CardCandidate[]): Bucket[] =>
  groupBy(cards, (c) => c.assignee || NO_ASSIGNEE);

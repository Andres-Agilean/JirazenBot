import { normalizeText } from '@/text/normalize.js';
import { BINDING_TTL_MS, slotKey, type Slot } from './bindings.js';
import { dedupeCandidates, type CardCandidate } from './search.js';

export interface CandidateSet {
  name: string;
  candidates: CardCandidate[];
  createdAt: number;
}

export interface CandidateStore {
  get(slot: Slot): Promise<CandidateSet | undefined>;
  set(slot: Slot, s: CandidateSet): Promise<void>;
  delete(slot: Slot): Promise<void>;
}

/** Same slot keying and 24h expiry-on-get as `InMemoryBindingStore`, measured from `createdAt`. */
export class InMemoryCandidateStore implements CandidateStore {
  private readonly sets = new Map<string, CandidateSet>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(slot: Slot): Promise<CandidateSet | undefined> {
    const key = slotKey(slot);
    const found = this.sets.get(key);
    if (!found) return undefined;
    if (this.now() - found.createdAt > BINDING_TTL_MS) {
      this.sets.delete(key);
      return undefined;
    }
    return found;
  }

  async set(slot: Slot, s: CandidateSet): Promise<void> {
    this.sets.set(slotKey(slot), s);
  }

  async delete(slot: Slot): Promise<void> {
    this.sets.delete(slotKey(slot));
  }
}

/** Typed text shorter than this is too vague to select anything. */
const MIN_MATCH_CHARS = 3;

/**
 * Resolves typed text to one candidate. Default: normalized substring match on label or summary
 * (nothing bound yet, so the text can only be about the list). `exactOnly`: a card is already
 * bound, so the text is presumably a question about IT -- only a whole label ("QZ-252",
 * "chamado 16467"; a Jira label IS its key) selects, and an unclear match never reports
 * ambiguity, it just yields null so the question falls through to the bound card. A bare ticket
 * number is deliberately NOT a label: with a card bound it is a question (the bare-number guard).
 * Plain `includes`/`===`, never a RegExp: user text like `norte (construtora)` must stay inert.
 * Hits are deduped by card, so the same card listed twice is not an ambiguity.
 */
export function matchCandidate(
  text: string,
  set: CandidateSet,
  opts: { exactOnly?: boolean } = {},
): CardCandidate | 'ambiguous' | null {
  const needle = normalizeText(text.trim());
  if (needle.length < MIN_MATCH_CHARS) return null;
  const matches = opts.exactOnly
    ? (c: CardCandidate) => normalizeText(c.label) === needle
    : (c: CardCandidate) => normalizeText(c.label).includes(needle) || normalizeText(c.summary).includes(needle);
  const hits = dedupeCandidates(set.candidates.filter(matches));
  if (hits.length === 1) return hits[0];
  return hits.length > 1 && !opts.exactOnly ? 'ambiguous' : null;
}

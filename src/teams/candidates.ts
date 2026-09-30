import { normalizeText } from '@/text/normalize.js';
import { BINDING_TTL_MS, slotKey, type Slot } from './bindings.js';
import type { CardCandidate } from './search.js';

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
 * Resolves typed text to one candidate by normalized substring match on label or summary.
 * Plain `includes`, never a RegExp: user text like `norte (construtora)` must stay inert.
 */
export function matchCandidate(text: string, set: CandidateSet): CardCandidate | 'ambiguous' | null {
  const needle = normalizeText(text.trim());
  if (needle.length < MIN_MATCH_CHARS) return null;
  const hits = set.candidates.filter(
    (c) => normalizeText(c.label).includes(needle) || normalizeText(c.summary).includes(needle),
  );
  if (hits.length === 1) return hits[0];
  return hits.length > 1 ? 'ambiguous' : null;
}

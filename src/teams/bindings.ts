import type { CardRef } from '@/resolve/types.js';
import type { CardBundle } from '@/bundle/types.js';
import type { Turn } from '@/claude/types.js';

/** How long the bot remembers WHICH card a conversation is about (plan §9.3). */
export const BINDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long the bot reuses THE DATA it fetched about that card before refetching both tenants
 * (Phase 3 spec §4). Deliberately much shorter than the binding: forgetting the card mid-thought
 * is infuriating, while answering "qual o status atual?" from an hour-old snapshot is a
 * correctness bug.
 */
export const BUNDLE_TTL_MS = 15 * 60 * 1000;

export interface Binding {
  ref: CardRef;
  /** Assembled once when the card is bound and reused; see Phase 2 spec §4 on cache stability. */
  bundle: CardBundle;
  bundleFetchedAt: number;
  history: Turn[];
  boundAt: number;
}

/**
 * Which binding a read or write targets. A thread's shared binding is the card the room is
 * discussing; a personal binding is one participant's private split from it (spec §4).
 */
export type Slot =
  | { scope: 'shared'; conversationId: string }
  | { scope: 'personal'; conversationId: string; userId: string };

/**
 * Length-prefixes the conversation id so a conversation id containing the separator cannot
 * produce the same key as some other conversation/user pair. Teams conversation ids contain
 * colons and semicolons routinely (`19:...@thread.tacv2;messageid=...`), so a naive join is a
 * real collision risk, not a theoretical one.
 */
export function slotKey(slot: Slot): string {
  const prefix = `${slot.conversationId.length}:${slot.conversationId}`;
  return slot.scope === 'shared' ? `s|${prefix}` : `p|${prefix}|${slot.userId}`;
}

export interface BindingStore {
  get(slot: Slot): Promise<Binding | undefined>;
  /**
   * Store a binding. This is a dumb store — it does not inspect or modify the binding's
   * `boundAt` field. It is the caller's responsibility to set `boundAt` correctly:
   * - when first binding a conversation to a card, set `boundAt` to now
   * - when re-binding a conversation to a different card, set a new `boundAt` to reset expiry
   * See InMemoryBindingStore.get() for how the 24h TTL is computed from `boundAt`.
   */
  set(slot: Slot, binding: Binding): Promise<void>;
  delete(slot: Slot): Promise<void>;
}

/** True when the bundle is older than BUNDLE_TTL_MS and must be refetched before answering. */
export function isBundleStale(binding: Binding, now: number): boolean {
  return now - binding.bundleFetchedAt > BUNDLE_TTL_MS;
}

/**
 * The only implementation in this phase. Restarts lose every binding, which is acceptable for a
 * demo-driven MVP and is the trigger for implementing a persistent store (plan §9.3: Azure Table
 * Storage or Redis) rather than a nice-to-have.
 */
export class InMemoryBindingStore implements BindingStore {
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(slot: Slot): Promise<Binding | undefined> {
    const key = slotKey(slot);
    const binding = this.bindings.get(key);
    if (!binding) return undefined;
    if (this.now() - binding.boundAt > BINDING_TTL_MS) {
      this.bindings.delete(key);
      return undefined;
    }
    return binding;
  }

  async set(slot: Slot, binding: Binding): Promise<void> {
    this.bindings.set(slotKey(slot), binding);
  }

  async delete(slot: Slot): Promise<void> {
    this.bindings.delete(slotKey(slot));
  }
}

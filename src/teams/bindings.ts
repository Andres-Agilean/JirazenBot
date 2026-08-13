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

export interface BindingStore {
  get(key: string): Promise<Binding | undefined>;
  set(key: string, binding: Binding): Promise<void>;
  delete(key: string): Promise<void>;
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

  async get(key: string): Promise<Binding | undefined> {
    const binding = this.bindings.get(key);
    if (!binding) return undefined;
    if (this.now() - binding.boundAt > BINDING_TTL_MS) {
      this.bindings.delete(key);
      return undefined;
    }
    return binding;
  }

  async set(key: string, binding: Binding): Promise<void> {
    this.bindings.set(key, binding);
  }

  async delete(key: string): Promise<void> {
    this.bindings.delete(key);
  }
}

import type { DirectoryUser } from '@/msgraph/directory.js';
import { BINDING_TTL_MS, slotKey, type Slot } from './bindings.js';

/**
 * The server-side record behind a reminder confirmation (reminder spec §5.1). Everything a send
 * needs lives here, so a button payload only names the record (`nonce`) and can never name a
 * recipient or a note.
 */
export interface PendingReminder {
  nonce: string;
  /** The resolved directory matches: one for a direct confirmation, several behind a pick card. */
  candidates: DirectoryUser[];
  /** Index into `candidates`; unset until a pick card is answered (a confirmation sets it at issue). */
  chosen?: number;
  cardKey: string;
  note?: string;
  createdAt: number;
}

export interface PendingReminderStore {
  get(slot: Slot): Promise<PendingReminder | undefined>;
  set(slot: Slot, r: PendingReminder): Promise<void>;
  delete(slot: Slot): Promise<void>;
}

/** Same slot keying and 24h expiry-on-get as `InMemoryCandidateStore`, measured from `createdAt`. */
export class InMemoryPendingReminderStore implements PendingReminderStore {
  private readonly records = new Map<string, PendingReminder>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(slot: Slot): Promise<PendingReminder | undefined> {
    const key = slotKey(slot);
    const found = this.records.get(key);
    if (!found) return undefined;
    if (this.now() - found.createdAt > BINDING_TTL_MS) {
      this.records.delete(key);
      return undefined;
    }
    return found;
  }

  async set(slot: Slot, r: PendingReminder): Promise<void> {
    this.records.set(slotKey(slot), r);
  }

  async delete(slot: Slot): Promise<void> {
    this.records.delete(slotKey(slot));
  }
}

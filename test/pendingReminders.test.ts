import { describe, expect, it } from 'vitest';
import { BINDING_TTL_MS, type Slot } from '@/teams/bindings.js';
import { InMemoryPendingReminderStore, type PendingReminder } from '@/teams/pendingReminders.js';

const T0 = 1_000_000;
const slot: Slot = { scope: 'shared', conversationId: 'c' };
const record = (over: Partial<PendingReminder> = {}): PendingReminder => ({
  nonce: 'n', candidates: [{ id: 'g1', displayName: 'João', mail: null }], cardKey: 'QZ-1', createdAt: T0, ...over,
});

describe('InMemoryPendingReminderStore (spec §5.1)', () => {
  it('returns what was set, and set replaces the slot record', async () => {
    const store = new InMemoryPendingReminderStore(() => T0);
    await store.set(slot, record({ nonce: 'a' }));
    await store.set(slot, record({ nonce: 'b' }));
    expect((await store.get(slot))?.nonce).toBe('b');
  });
  it('expires on get after the binding TTL, measured from createdAt', async () => {
    let now = T0;
    const store = new InMemoryPendingReminderStore(() => now);
    await store.set(slot, record());
    now = T0 + BINDING_TTL_MS;
    expect(await store.get(slot)).toBeDefined();
    now = T0 + BINDING_TTL_MS + 1;
    expect(await store.get(slot)).toBeUndefined();
  });
  it('delete consumes the record', async () => {
    const store = new InMemoryPendingReminderStore(() => T0);
    await store.set(slot, record());
    await store.delete(slot);
    expect(await store.get(slot)).toBeUndefined();
  });
});

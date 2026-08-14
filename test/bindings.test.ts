import { describe, expect, it } from 'vitest';
import {
  BINDING_TTL_MS, BUNDLE_TTL_MS, InMemoryBindingStore, isBundleStale, slotKey, type Binding,
  type Slot,
} from '@/teams/bindings.js';
import type { CardBundle } from '@/bundle/types.js';

const bundle = {
  fetchedAt: '2026-08-13T12:00:00.000Z',
  surface: 'dm',
  jira: { issueId: '42395', issueKey: 'QZ-252', fields: {}, comments: [], statusHistory: [] },
  resolution: { via: 'jira_zendesk_id_field', ambiguous: false },
  truncationNotes: [],
} as CardBundle;

const T0 = 1_000_000;

function makeBinding(boundAt = T0, bundleFetchedAt = T0): Binding {
  return {
    ref: { system: 'jira', issueKey: 'QZ-252', explicit: true },
    bundle,
    bundleFetchedAt,
    history: [],
    boundAt,
  };
}

describe('InMemoryBindingStore', () => {
  it('returns what was stored', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set({ scope: 'shared', conversationId: 'conv-1' }, makeBinding());
    expect((await store.get({ scope: 'shared', conversationId: 'conv-1' }))?.ref).toEqual({
      system: 'jira', issueKey: 'QZ-252', explicit: true,
    });
  });

  it('returns undefined for an unknown key', async () => {
    const store = new InMemoryBindingStore(() => T0);
    expect(await store.get({ scope: 'shared', conversationId: 'nobody' })).toBeUndefined();
  });

  it('keeps a binding right up to the 24h limit', async () => {
    let now = T0;
    const store = new InMemoryBindingStore(() => now);
    await store.set({ scope: 'shared', conversationId: 'conv-1' }, makeBinding());
    now = T0 + BINDING_TTL_MS;
    expect(await store.get({ scope: 'shared', conversationId: 'conv-1' })).toBeDefined();
  });

  it('expires and evicts a binding past 24h', async () => {
    let now = T0;
    const store = new InMemoryBindingStore(() => now);
    await store.set({ scope: 'shared', conversationId: 'conv-1' }, makeBinding());
    now = T0 + BINDING_TTL_MS + 1;
    expect(await store.get({ scope: 'shared', conversationId: 'conv-1' })).toBeUndefined();
    // evicted, not merely hidden
    now = T0;
    expect(await store.get({ scope: 'shared', conversationId: 'conv-1' })).toBeUndefined();
  });

  it('keeps a binding valid while its bundle independently goes stale', async () => {
    let now = T0;
    const store = new InMemoryBindingStore(() => now);
    // Bind at T0 but fetch bundle much earlier
    await store.set(
      { scope: 'shared', conversationId: 'conv-1' },
      makeBinding(T0, T0 - 20 * 60 * 1000),
    ); // bundle 20 minutes old
    now = T0 + 10 * 60 * 1000; // advance 10 minutes
    const binding = await store.get({ scope: 'shared', conversationId: 'conv-1' });
    // binding is still live (only 10m old, needs 24h to expire)
    expect(binding).toBeDefined();
    // but bundle is stale (was already 20m old, now 30m total, past 15m threshold)
    expect(isBundleStale(binding!, now)).toBe(true);
  });

  it('keys conversations independently', async () => {
    const store = new InMemoryBindingStore(() => T0);
    const refA = { system: 'jira' as const, issueKey: 'QZ-252', explicit: true };
    const refB = { system: 'zendesk' as const, ticketId: '999', explicit: false };
    const bindingA = { ...makeBinding(), ref: refA };
    const bindingB = { ...makeBinding(), ref: refB };
    await store.set({ scope: 'shared', conversationId: 'conv-1' }, bindingA);
    await store.set({ scope: 'shared', conversationId: 'conv-2' }, bindingB);
    expect((await store.get({ scope: 'shared', conversationId: 'conv-1' }))?.ref).toEqual(refA);
    expect((await store.get({ scope: 'shared', conversationId: 'conv-2' }))?.ref).toEqual(refB);
  });

  it('overwrites an existing key with a new binding', async () => {
    const store = new InMemoryBindingStore(() => T0);
    const binding1 = makeBinding(T0, T0);
    const binding2 = {
      ref: { system: 'zendesk' as const, ticketId: '999', explicit: false },
      bundle,
      bundleFetchedAt: T0 + 1000,
      history: [{ role: 'user' as const, text: 'hello' }],
      boundAt: T0 + 1000,
    };
    await store.set({ scope: 'shared', conversationId: 'conv-1' }, binding1);
    await store.set({ scope: 'shared', conversationId: 'conv-1' }, binding2);
    const retrieved = await store.get({ scope: 'shared', conversationId: 'conv-1' });
    expect(retrieved?.ref.system).toBe('zendesk');
    expect(retrieved?.boundAt).toBe(T0 + 1000);
  });

  it('deletes', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set({ scope: 'shared', conversationId: 'conv-1' }, makeBinding());
    await store.delete({ scope: 'shared', conversationId: 'conv-1' });
    expect(await store.get({ scope: 'shared', conversationId: 'conv-1' })).toBeUndefined();
  });
});

describe('isBundleStale', () => {
  it('is fresh up to 15 minutes and stale after', () => {
    const b = makeBinding();
    expect(isBundleStale(b, T0)).toBe(false);
    expect(isBundleStale(b, T0 + BUNDLE_TTL_MS)).toBe(false);
    expect(isBundleStale(b, T0 + BUNDLE_TTL_MS + 1)).toBe(true);
  });

  it('uses a shorter window than the binding lifetime', () => {
    expect(BUNDLE_TTL_MS).toBeLessThan(BINDING_TTL_MS);
  });
});

const shared = (c: string): Slot => ({ scope: 'shared', conversationId: c });
const personal = (c: string, u: string): Slot => ({ scope: 'personal', conversationId: c, userId: u });

describe('slots', () => {
  it('keeps a shared and a personal binding side by side', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set(shared('conv'), makeBinding());
    await store.set(personal('conv', 'bruno'), makeBinding());
    expect(await store.get(shared('conv'))).toBeDefined();
    expect(await store.get(personal('conv', 'bruno'))).toBeDefined();
  });

  it('keeps two users personal bindings apart in one conversation', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set(personal('conv', 'ana'), makeBinding());
    expect(await store.get(personal('conv', 'bruno'))).toBeUndefined();
  });

  it('does not let a personal binding satisfy a shared read', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set(personal('conv', 'ana'), makeBinding());
    expect(await store.get(shared('conv'))).toBeUndefined();
  });

  it('deletes only the slot asked for', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set(shared('conv'), makeBinding());
    await store.set(personal('conv', 'ana'), makeBinding());
    await store.delete(personal('conv', 'ana'));
    expect(await store.get(personal('conv', 'ana'))).toBeUndefined();
    expect(await store.get(shared('conv'))).toBeDefined();
  });

  it('expires each slot on its own 24h clock', async () => {
    let now = T0;
    const store = new InMemoryBindingStore(() => now);
    await store.set(shared('conv'), makeBinding(T0));
    await store.set(personal('conv', 'ana'), makeBinding(T0 + 1000));
    now = T0 + BINDING_TTL_MS + 1;
    expect(await store.get(shared('conv'))).toBeUndefined();
    expect(await store.get(personal('conv', 'ana'))).toBeDefined();
  });
});

describe('slotKey', () => {
  it('cannot collide a conversation id with a personal slot', () => {
    // A naive `${conversationId}:${userId}` scheme collides if a conversation id contains the
    // separator. Distinct scopes must never produce the same key.
    const a = slotKey({ scope: 'shared', conversationId: 'conv:ana' });
    const b = slotKey({ scope: 'personal', conversationId: 'conv', userId: 'ana' });
    expect(a).not.toBe(b);
  });
});

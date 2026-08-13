import { describe, expect, it } from 'vitest';
import {
  BINDING_TTL_MS, BUNDLE_TTL_MS, InMemoryBindingStore, isBundleStale, type Binding,
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

function makeBinding(at = T0): Binding {
  return {
    ref: { system: 'jira', issueKey: 'QZ-252', explicit: true },
    bundle,
    bundleFetchedAt: at,
    history: [],
    boundAt: at,
  };
}

describe('InMemoryBindingStore', () => {
  it('returns what was stored', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set('conv-1', makeBinding());
    expect((await store.get('conv-1'))?.ref).toEqual({
      system: 'jira', issueKey: 'QZ-252', explicit: true,
    });
  });

  it('returns undefined for an unknown key', async () => {
    const store = new InMemoryBindingStore(() => T0);
    expect(await store.get('nobody')).toBeUndefined();
  });

  it('keeps a binding right up to the 24h limit', async () => {
    let now = T0;
    const store = new InMemoryBindingStore(() => now);
    await store.set('conv-1', makeBinding());
    now = T0 + BINDING_TTL_MS;
    expect(await store.get('conv-1')).toBeDefined();
  });

  it('expires and evicts a binding past 24h', async () => {
    let now = T0;
    const store = new InMemoryBindingStore(() => now);
    await store.set('conv-1', makeBinding());
    now = T0 + BINDING_TTL_MS + 1;
    expect(await store.get('conv-1')).toBeUndefined();
    // evicted, not merely hidden
    now = T0;
    expect(await store.get('conv-1')).toBeUndefined();
  });

  it('keys conversations independently', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set('conv-1', makeBinding());
    expect(await store.get('conv-2')).toBeUndefined();
  });

  it('deletes', async () => {
    const store = new InMemoryBindingStore(() => T0);
    await store.set('conv-1', makeBinding());
    await store.delete('conv-1');
    expect(await store.get('conv-1')).toBeUndefined();
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

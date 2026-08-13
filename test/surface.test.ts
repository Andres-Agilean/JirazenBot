import { describe, expect, it } from 'vitest';
import { surfaceFor } from '@/teams/surface.js';

describe('surfaceFor', () => {
  it('treats only a personal 1:1 chat as dm', () => {
    expect(surfaceFor('personal')).toBe('dm');
  });

  it('treats known multiparty types as multiparty', () => {
    expect(surfaceFor('groupChat')).toBe('multiparty');
    expect(surfaceFor('channel')).toBe('multiparty');
  });

  // The SDK types this field as an OPEN union ('personal' | 'groupChat' | Omit<string, ...>),
  // so an unrecognised value is reachable, not theoretical. Failing closed means a future Teams
  // conversation type omits internal Zendesk notes rather than leaking them (spec §2).
  it('fails closed on unknown and missing types', () => {
    expect(surfaceFor('someFutureTeamsScope')).toBe('multiparty');
    expect(surfaceFor(undefined)).toBe('multiparty');
    expect(surfaceFor('')).toBe('multiparty');
    expect(surfaceFor('Personal')).toBe('multiparty'); // exact match only
  });
});

import { describe, expect, it } from 'vitest';
import { parseCardArgs } from '../scripts/parseCardArgs.js';

describe('parseCardArgs', () => {
  it('parses a bare reference with no --surface flag (regression: used to drop args[0])', () => {
    expect(parseCardArgs(['QZ-252'])).toEqual({ ok: true, args: { refText: 'QZ-252', surface: 'dm' } });
  });

  it('parses a multi-word bare reference with no --surface flag', () => {
    expect(parseCardArgs(['chamado', '16467'])).toEqual({ ok: true, args: { refText: 'chamado 16467', surface: 'dm' } });
  });

  it('strips --surface and its value from the reference text', () => {
    expect(parseCardArgs(['chamado', '16467', '--surface', 'multiparty'])).toEqual({
      ok: true,
      args: { refText: 'chamado 16467', surface: 'multiparty' },
    });
  });

  it('strips --surface when it appears before the reference', () => {
    expect(parseCardArgs(['--surface', 'multiparty', 'QZ-252'])).toEqual({
      ok: true,
      args: { refText: 'QZ-252', surface: 'multiparty' },
    });
  });

  it('rejects an invalid --surface value instead of failing open on the confidentiality control', () => {
    const r = parseCardArgs(['chamado', '16467', '--surface', 'multipary']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error result');
    expect(r.error).toContain('multipary');
    expect(r.error).toContain('dm');
    expect(r.error).toContain('multiparty');
  });

  it('rejects a trailing --surface with no following value', () => {
    const r = parseCardArgs(['chamado', '16467', '--surface']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error result');
    expect(r.error).toContain('ausente');
  });
});

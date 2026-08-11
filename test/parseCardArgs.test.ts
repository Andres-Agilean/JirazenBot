import { describe, expect, it } from 'vitest';
import { parseCardArgs } from '../scripts/parseCardArgs.js';

describe('parseCardArgs', () => {
  it('parses a bare reference with no --surface flag (regression: used to drop args[0])', () => {
    expect(parseCardArgs(['QZ-252'])).toEqual({ refText: 'QZ-252', surface: 'dm' });
  });

  it('parses a multi-word bare reference with no --surface flag', () => {
    expect(parseCardArgs(['chamado', '16467'])).toEqual({ refText: 'chamado 16467', surface: 'dm' });
  });

  it('strips --surface and its value from the reference text', () => {
    expect(parseCardArgs(['chamado', '16467', '--surface', 'multiparty'])).toEqual({
      refText: 'chamado 16467',
      surface: 'multiparty',
    });
  });

  it('strips --surface when it appears before the reference', () => {
    expect(parseCardArgs(['--surface', 'multiparty', 'QZ-252'])).toEqual({
      refText: 'QZ-252',
      surface: 'multiparty',
    });
  });
});

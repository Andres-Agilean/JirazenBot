import { describe, expect, it } from 'vitest';
import { normalizeText } from '@/text/normalize.js';

describe('normalizeText', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeText('AJUDA')).toBe('ajuda');
    expect(normalizeText('Atualizar')).toBe('atualizar');
    expect(normalizeText('André')).toBe('andre');
    expect(normalizeText('não consta')).toBe('nao consta');
    expect(normalizeText('coleção')).toBe('colecao');
  });

  it('leaves already-normal text unchanged', () => {
    expect(normalizeText('qz-252')).toBe('qz-252');
  });
});

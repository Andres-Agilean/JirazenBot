import { describe, expect, it } from 'vitest';
import { detectPortfolioQuery, parseBuscar } from '@/resolve/portfolioIntent.js';

describe('detectPortfolioQuery', () => {
  it.each([
    // The name keeps the user's original casing/accents (it goes to vendors verbatim); only
    // pattern matching is done on normalized text.
    ['qual o status da empresa Norte Construtora?', 'Norte Construtora', 'rundown'],
    ['como estão as coisas do cliente Vale Verde', 'Vale Verde', 'rundown'],
    ['andamento da obra Jaguaribe', 'Jaguaribe', 'rundown'],
    ['status do projeto QuizQuality', 'QuizQuality', 'rundown'],
    ['empresa Norte Construtora', 'Norte Construtora', 'rundown'],
    ['empresa São Bento', 'São Bento', 'rundown'],
  ])('detects portfolio shape: %s', (text, name, mode) => {
    expect(detectPortfolioQuery(text)).toEqual({ name, mode });
  });

  it('detects card shape when a defect word precedes the name', () => {
    expect(detectPortfolioQuery('qual o status do problema da obra Jaguaribe?'))
      .toEqual({ name: 'Jaguaribe', mode: 'candidates' });
  });

  it.each([
    'quem validou a correção?',
    'a obra atrasou muito?',        // kind word but no extractable name pattern beyond one word — see impl note
    'a manobra do guindaste falhou', //"obra" inside another word must not anchor a query
    'a cobra multa da prefeitura',
    'QZ-252',
    'atualizar',
    '',
  ])('returns null for non-portfolio text: %s', (text) => {
    // 'a obra atrasou muito?' asserts the trailing-question strip + minimum name shape; if the
    // implementation admits it, the cost is a failed search instead of help text (spec §3) — but
    // prefer rejecting names that are single common verbs. See Step 3's STOP_NAMES.
    expect(detectPortfolioQuery(text)).toBeNull();
  });

  it('keeps accents and case in the name, including a decomposed (NFD) input', () => {
    expect(detectPortfolioQuery('EMPRESA São Bento?')?.name).toBe('São Bento');
    expect(detectPortfolioQuery('empresa São Bento')?.name).toBe('São Bento');
  });

  it('rejects a stop-word name regardless of accents or case', () => {
    expect(detectPortfolioQuery('a obra Está atrasada')).toBeNull();
  });

  it('trims the name after the length cap', () => {
    const long = `empresa ${'x'.repeat(59)} yyy`;
    expect(detectPortfolioQuery(long)?.name).toBe('x'.repeat(59));
  });

  it('caps the extracted name length', () => {
    const long = `empresa ${'x'.repeat(100)}`;
    expect(detectPortfolioQuery(long)?.name.length).toBeLessThanOrEqual(60);
  });
});

describe('parseBuscar', () => {
  it('extracts the name from "buscar <nome>"', () => {
    expect(parseBuscar('buscar Norte Construtora')).toBe('Norte Construtora');
  });
  it('keeps accents and case for the vendor query', () => {
    expect(parseBuscar('Buscar São Bento')).toBe('São Bento');
    expect(parseBuscar('buscar São Bento')).toBe('São Bento');
  });
  it('returns null for bare "buscar" and for other text', () => {
    expect(parseBuscar('buscar')).toBeNull();
    expect(parseBuscar('busca algo')).toBeNull();
    expect(parseBuscar('qual o status?')).toBeNull();
  });
});

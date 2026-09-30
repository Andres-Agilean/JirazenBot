import { describe, expect, it } from 'vitest';
import { detectPortfolioQuery, parseBuscar } from '@/resolve/portfolioIntent.js';

describe('detectPortfolioQuery', () => {
  it.each([
    ['qual o status da empresa Norte Construtora?', 'norte construtora', 'rundown'],
    ['como estão as coisas do cliente Vale Verde', 'vale verde', 'rundown'],
    ['andamento da obra Jaguaribe', 'jaguaribe', 'rundown'],
    ['status do projeto QuizQuality', 'quizquality', 'rundown'],
    ['empresa Norte Construtora', 'norte construtora', 'rundown'],
  ])('detects portfolio shape: %s', (text, name, mode) => {
    expect(detectPortfolioQuery(text)).toEqual({ name, mode });
  });

  it('detects card shape when a defect word precedes the name', () => {
    expect(detectPortfolioQuery('qual o status do problema da obra Jaguaribe?'))
      .toEqual({ name: 'jaguaribe', mode: 'candidates' });
  });

  it.each([
    'quem validou a correção?',
    'a obra atrasou muito?',        // kind word but no extractable name pattern beyond one word — see impl note
    'QZ-252',
    'atualizar',
    '',
  ])('returns null for non-portfolio text: %s', (text) => {
    // 'a obra atrasou muito?' asserts the trailing-question strip + minimum name shape; if the
    // implementation admits it, the cost is a failed search instead of help text (spec §3) — but
    // prefer rejecting names that are single common verbs. See Step 3's STOP_NAMES.
    expect(detectPortfolioQuery(text)).toBeNull();
  });

  it('caps the extracted name length', () => {
    const long = `empresa ${'x'.repeat(100)}`;
    expect(detectPortfolioQuery(long)?.name.length).toBeLessThanOrEqual(60);
  });
});

describe('parseBuscar', () => {
  it('extracts the name from "buscar <nome>"', () => {
    expect(parseBuscar('buscar Norte Construtora')).toBe('norte construtora');
  });
  it('returns null for bare "buscar" and for other text', () => {
    expect(parseBuscar('buscar')).toBeNull();
    expect(parseBuscar('busca algo')).toBeNull();
    expect(parseBuscar('qual o status?')).toBeNull();
  });
});

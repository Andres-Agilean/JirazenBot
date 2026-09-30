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

  it.each([
    ['como estao os cards da Dalle?', 'Dalle'],                 // live miss, verbatim
    ['como estao as atividades da dalle?', 'dalle'],           // live miss, verbatim
    ['quais os chamados da Norte Construtora', 'Norte Construtora'],
    ['tickets da Vale Verde', 'Vale Verde'],
    ['pendências da São Bento?', 'São Bento'],
    ['demandas do Jaguaribe', 'Jaguaribe'],
  ])('plural subject words anchor a rundown: %s', (text, name) => {
    expect(detectPortfolioQuery(text)).toEqual({ name, mode: 'rundown' });
  });

  it.each([
    ['qual o status das atividades no Jardins de Potengi?', 'Jardins de Potengi'],
    ['como estao as atividades na Dalle', 'Dalle'],
    ['atividades nos Jardins de Potengi', 'Jardins de Potengi'],
    ['atividades nas Obras Norte', 'Obras Norte'],
    ['como estao as atividades em São Bento?', 'São Bento'],
    ['status do projeto em Jaguaribe', 'Jaguaribe'],
  ])('na/no/nas/nos/em connectives are stripped after the anchor: %s', (text, name) => {
    expect(detectPortfolioQuery(text)).toEqual({ name, mode: 'rundown' });
  });

  it('a name that merely starts with a connective-like word keeps it', () => {
    expect(detectPortfolioQuery('empresa Nova Era')?.name).toBe('Nova Era');
    expect(detectPortfolioQuery('empresa Emplacar')?.name).toBe('Emplacar');
  });

  it('plural anchors never flip to candidates (chamados/tickets are not CARD_SHAPE)', () => {
    expect(detectPortfolioQuery('erro nos chamados da Dalle')?.mode).toBe('rundown');
  });

  it('singular defect words still flip to candidates', () => {
    expect(detectPortfolioQuery('qual o status do chamado da obra X')).toEqual({ name: 'X', mode: 'candidates' });
  });

  it('a plural word with no name after it is not a query', () => {
    expect(detectPortfolioQuery('quantos cards?')).toBeNull();
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

describe('detectPortfolioQuery loose bare-name shapes (spec §10.4)', () => {
  it.each([
    ['qual o status da dalle?', 'dalle'],
    ['qual é o status da Dalle?', 'Dalle'],
    ['qual a situação do Jardins de Potengi?', 'Jardins de Potengi'],
    ['qual o andamento da norte construtora?', 'norte construtora'],
    ['como está a dalle?', 'dalle'],
    ['como anda a Dalle?', 'Dalle'],
    ['como estão os Jardins de Potengi', 'Jardins de Potengi'],
  ])('detects %s as a rundown', (text, name) => {
    expect(detectPortfolioQuery(text)).toEqual({ name, mode: 'rundown' });
  });

  it.each([
    'qual o status?',
    'qual o status do QZ-252?',
    'qual o status do chamado 16467?',
    'qual o status do #16467?',
    'qual o status do 16467?',
    'qual o status do https://x.zendesk.com/agent/tickets/1?',
    'como está atrasada a obra?',
    'me diga qual o status da dalle',
    'como está a?',
    'como está a',
  ])('returns null for %s', (text) => {
    expect(detectPortfolioQuery(text)).toBeNull();
  });

  it('anchored patterns still win over the loose shapes', () => {
    expect(detectPortfolioQuery('qual o status da empresa dalle?')).toEqual({ name: 'dalle', mode: 'rundown' });
  });
});

describe('detectPortfolioQuery allowLoose (spec §10.4 as amended: loose shapes only with no stored portfolio)', () => {
  it.each([
    'qual o status da dalle?',
    'como está a dalle?',
    'como estão os bloqueados?',
    'qual o status dos pendentes?',
    'como está o João?',
    'como anda o resto?',
  ])('allowLoose:false returns null for loose shape %s', (text) => {
    expect(detectPortfolioQuery(text, { allowLoose: false })).toBeNull();
  });

  it('allowLoose defaults to true', () => {
    expect(detectPortfolioQuery('qual o status da dalle?', {})).toEqual({ name: 'dalle', mode: 'rundown' });
  });

  it.each([
    ['como estao as atividades da dalle?', 'dalle'],
    ['qual o status da empresa dalle?', 'dalle'],
    ['como estão os projetos da empresa Norte', 'Norte'],
  ])('anchored shape %s still fires with allowLoose:false', (text, name) => {
    expect(detectPortfolioQuery(text, { allowLoose: false })).toEqual({ name, mode: 'rundown' });
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

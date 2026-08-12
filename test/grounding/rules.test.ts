import { describe, expect, it } from 'vitest';
import {
  ANY_DATE, checkRules, mustAdmitGap, mustCite, mustContain, mustMatch, mustNotContain, mustNotInventDate, mustNotMatch,
} from './rules.js';

describe('rule constructors', () => {
  it('mustContain is case- and accent-insensitive', () => {
    expect(mustContain('André').check('falou com andre marques')).toBe(true);
    expect(mustContain('André').check('ninguém falou')).toBe(false);
  });

  it('mustNotContain inverts mustContain', () => {
    expect(mustNotContain('prazo').check('sem data definida')).toBe(true);
    expect(mustNotContain('prazo').check('o prazo é sexta')).toBe(false);
  });

  it('mustMatch and mustNotMatch apply the regex directly', () => {
    expect(mustMatch(/\d{4}-\d{2}-\d{2}/, 'iso date').check('em 2026-08-11')).toBe(true);
    expect(mustNotMatch(/\d{2}\/\d{2}\/\d{4}/, 'invented date').check('em 11/08/2026')).toBe(false);
  });

  it('mustCite requires the bracketed bundle label', () => {
    const rule = mustCite('comentário jira 41713');
    expect(rule.check('Aprovado [comentário jira 41713].')).toBe(true);
    expect(rule.check('Aprovado no comentário 41713.')).toBe(false);
  });

  it('rejects a citation mentioned in prose without the bracket', () => {
    expect(mustCite('comentário jira 41713').check('Aprovado, ver comentário jira 41713.')).toBe(false);
  });

  it('mustAdmitGap accepts common pt-BR gap phrasings', () => {
    const rule = mustAdmitGap();
    expect(rule.check('O bundle não contém essa informação.')).toBe(true);
    expect(rule.check('Não há menção a uma data alvo.')).toBe(true);
    expect(rule.check('Não encontrei esse dado no card.')).toBe(true);
    expect(rule.check('Não consta nos comentários.')).toBe(true);
    expect(rule.check('A data alvo é 15/08.')).toBe(false);
  });

  it('is only a screen: it cannot tell which gap was admitted (see mustNotInventDate + judge)', () => {
    const rule = mustAdmitGap();
    // An answer can admit one gap while fabricating something else. This rule cannot catch that;
    // pairing it with mustNotInventDate() and a judge criterion is what closes the case.
    expect(rule.check('Não consta atraso no chamado; o prazo de entrega é 15/08.')).toBe(true);
    expect(mustNotInventDate().check('Não consta atraso no chamado; o prazo de entrega é 15/08.')).toBe(false);
  });

  it('rejects answers with no gap language at all', () => {
    expect(mustAdmitGap().check('A data alvo é 15/08.')).toBe(false);
    expect(mustAdmitGap().check('O responsável é o Bruno Tavares.')).toBe(false);
  });

  it('mustNotInventDate rejects dates in pt-BR and ISO formats', () => {
    expect(mustNotInventDate().check('O prazo é 15/08.')).toBe(false);
    expect(mustNotInventDate().check('Entrega em 15/08/2026.')).toBe(false);
    expect(mustNotInventDate().check('Previsto para 2026-08-15.')).toBe(false);
  });

  it('mustNotInventDate accepts answers without specific dates', () => {
    expect(mustNotInventDate().check('O card não registra um prazo.')).toBe(true);
    expect(mustNotInventDate().check('Foram 26 casos de teste, todos aprovados.')).toBe(true);
  });

  it('mustNotInventDate does not flag routine N/M ratios as dates', () => {
    expect(mustNotInventDate().check('Foram concluídas 8/10 subtarefas.')).toBe(true);
    expect(mustNotInventDate().check('O card está no Sprint 23/24.')).toBe(true);
    expect(mustNotInventDate().check('Há 3/5 aprovações registradas no card.')).toBe(true);
    expect(mustNotInventDate().check('Nota 10/10 no teste.')).toBe(true);
  });

  it('mustNotInventDate still catches real dates alongside gap language', () => {
    // These are the cases the fix must not regress: a genuine deadline stated in DD/MM,
    // DD/MM/YYYY, or ISO form must still be caught even though bare-ratio shapes now pass.
    expect(mustNotInventDate().check('O prazo é 15/08.')).toBe(false);
    expect(mustNotInventDate().check('Entrega em 15/08/2026.')).toBe(false);
    expect(mustNotInventDate().check('Previsto para 2026-08-15.')).toBe(false);
  });

  it('accepts the phrasings a model actually uses when declining', () => {
    const rule = mustAdmitGap();
    for (const s of [
      'O card não contém essa informação.',
      'Não consta nos comentários.',
      'Não encontrei esse dado.',
      'Não localizei nenhuma data alvo.',
      'Não tenho essa informação no bundle.',
      'Não foi possível confirmar a partir do card.',
      'Não há registro de um prazo.',
      'Os comentários não mencionam uma data alvo.',
      'Sem informação sobre a versão.',
      'Não há nenhuma informação sobre o prazo.',
      'Não há nenhum registro de aprovação.',
      'Não há nenhuma menção a testes em iOS.',
    ]) {
      expect(rule.check(s), s).toBe(true);
    }
  });
});

describe('checkRules', () => {
  it('returns one failure per broken rule, and nothing when all pass', () => {
    const rules = [mustContain('16467'), mustNotContain('prazo')];
    expect(checkRules('chamado 16467 sem data', rules)).toEqual([]);
    expect(checkRules('o prazo é sexta', rules)).toEqual([
      { label: 'deve conter "16467"' },
      { label: 'não deve conter "prazo"' },
    ]);
  });
});

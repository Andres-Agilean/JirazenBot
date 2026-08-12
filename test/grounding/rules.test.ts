import { describe, expect, it } from 'vitest';
import {
  checkRules, mustAdmitGap, mustCite, mustContain, mustMatch, mustNotContain, mustNotMatch,
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

  it('rejects generic negation that is not an admission of a gap', () => {
    const rule = mustAdmitGap();
    expect(rule.check('Não há problema, o André confirmou que o prazo é 15/08.')).toBe(false);
    expect(rule.check('O card não está atualizado desde ontem, mas o prazo é sexta.')).toBe(false);
    expect(rule.check('Não existe erro no sistema; a entrega será em 15/08.')).toBe(false);
    expect(rule.check('Não há nenhuma dúvida de que o prazo é 15/08.')).toBe(false);
    expect(rule.check('O cliente não foi informado da mudança, e o prazo confirmado é 15/08.')).toBe(false);
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

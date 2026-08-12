import { describe, expect, it } from 'vitest';
import {
  checkRules, mustAdmitGap, mustCite, mustContain, mustMatch, mustNotContain, mustNotInventDate, mustNotMatch,
} from './rules.js';

/** Answers that state a date and must therefore fail mustNotInventDate(). */
const INVENTED_DATE_ANSWERS = [
  'O prazo é 15/08.',
  'Entrega em 15/08/2026.',
  'Previsto para 2026-08-15.',
  'O card está no Sprint 23/24, mas o prazo é 15/08.',
  'A data de entrega é 03/09.',
];

/** Truthful answers with no invented date; the n/m ones are ratios, not DD/MM dates. */
const DATE_FREE_ANSWERS = [
  'O card não registra um prazo.',
  'Foram 26 casos de teste, todos aprovados.',
  'Foram concluídas 8/10 subtarefas.',
  'O card está no Sprint 23/24.',
  'Há 3/5 aprovações registradas no card.',
  'Nota 10/10 no teste.',
  'O prazo não consta. Foram concluídas 8/10 subtarefas.',
  'Também revisamos 8/10 subtarefas em reunião passada.',
  'Vamos revisar até 8/10 subtarefas concluídas hoje.',
];

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

  it('mustNotInventDate flags a stated date in pt-BR and ISO shapes', () => {
    // Includes a real date preceded by an implausible ratio ("Sprint 23/24, mas o prazo é
    // 15/08"): every slash pair in the sentence must be inspected, not just the first.
    const rule = mustNotInventDate();
    for (const s of INVENTED_DATE_ANSWERS) expect(rule.check(s), s).toBe(false);
  });

  it('mustNotInventDate does not flag routine N/M ratios as dates', () => {
    // The last three carry a date-context word ("prazo") or an ordinary preposition ("em",
    // "até") outside the ratio's own sentence: neither may re-admit the ratio as a date.
    const rule = mustNotInventDate();
    for (const s of DATE_FREE_ANSWERS) expect(rule.check(s), s).toBe(true);
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

import { describe, expect, it } from 'vitest';
import {
  checkRules, mustAdmitGap, mustCite, mustContain, mustMatch, mustNotContain, mustNotInventDate, mustNotMatch,
} from './rules.js';
import { CASES } from './cases.js';
import { richBundle } from './bundles.js';

// Substrings of the rule labels the constructors in rules.ts actually produce (see their
// `label` fields) -- kept as named constants so the structural test below and this comment
// can't silently drift out of sync with each other.
const GAP_SCREEN_LABEL_SUBSTRING = 'triagem';
const DATE_CHECK_LABEL_SUBSTRING = 'data específica';
const MIN_REFUSAL_CASES = 10;

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
    // pairing it with mustNotInventDate() and a judge criterion is what closes the case. 15/08 is
    // not among richBundle's own dates (03, 05, 10, 11, 12 Aug), so it is still invented.
    expect(rule.check('Não consta atraso no chamado; o prazo de entrega é 15/08.')).toBe(true);
    expect(
      mustNotInventDate(richBundle).check('Não consta atraso no chamado; o prazo de entrega é 15/08.'),
    ).toBe(false);
  });

  it('mustAdmitGap is a screen; mustContain and mustCite are not', () => {
    expect(mustAdmitGap().kind).toBe('screen');
    expect(mustContain('x').kind).not.toBe('screen');
    expect(mustCite('campo Status').kind).not.toBe('screen');
  });

  it('rejects answers with no gap language at all', () => {
    expect(mustAdmitGap().check('A data alvo é 15/08.')).toBe(false);
    expect(mustAdmitGap().check('O responsável é o Bruno Tavares.')).toBe(false);
  });

  it('mustNotInventDate flags a stated date in pt-BR and ISO shapes not present in the bundle', () => {
    // Includes a real date preceded by an implausible ratio ("Sprint 23/24, mas o prazo é
    // 15/08"): every slash pair in the sentence must be inspected, not just the first. None of
    // these dates (15/08, 03/09) appear anywhere in richBundle (03, 05, 10, 11, 12 Aug).
    const rule = mustNotInventDate(richBundle);
    for (const s of INVENTED_DATE_ANSWERS) expect(rule.check(s), s).toBe(false);
  });

  it('mustNotInventDate does not flag routine N/M ratios as dates', () => {
    // The last three carry a date-context word ("prazo") or an ordinary preposition ("em",
    // "até") outside the ratio's own sentence: neither may re-admit the ratio as a date.
    const rule = mustNotInventDate(richBundle);
    for (const s of DATE_FREE_ANSWERS) expect(rule.check(s), s).toBe(true);
  });

  it('mustNotInventDate passes a date quoted verbatim from the bundle (ISO form)', () => {
    // richBundle's own status history records the Em Teste transition on 2026-08-10.
    const rule = mustNotInventDate(richBundle);
    expect(rule.check('O card mudou para Em Teste em 2026-08-10.')).toBe(true);
  });

  it('mustNotInventDate passes the pt-BR DD/MM rendering of a bundle date', () => {
    // richBundle's fetched_at is 2026-08-12T13:00:00.000Z -- the system prompt requires citing
    // it, and a model writing "12/08" for it must not be punished for the pt-BR rendering.
    const rule = mustNotInventDate(richBundle);
    expect(rule.check('O prazo não consta; dados coletados em 12/08.')).toBe(true);
  });

  it('mustNotInventDate passes the pt-BR DD/MM/YYYY rendering of a bundle date', () => {
    // richBundle's Jira issue was created on 2026-08-03.
    const rule = mustNotInventDate(richBundle);
    expect(rule.check('O card foi criado em 03/08/2026.')).toBe(true);
  });

  it('mustNotInventDate fails a date absent from the bundle, in any shape', () => {
    const rule = mustNotInventDate(richBundle);
    expect(rule.check('O prazo prometido é 20/08.')).toBe(false);
    expect(rule.check('Previsto para 2026-09-01.')).toBe(false);
    expect(rule.check('Entrega em 20/08/2026.')).toBe(false);
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

describe('eval corpus', () => {
  it('has 30 cases with unique ids', () => {
    expect(CASES).toHaveLength(30);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(30);
  });

  it('is weighted toward not-in-bundle cases', () => {
    const notInBundle = CASES.filter((c) => c.category === 'not_in_bundle');
    expect(notInBundle.length).toBeGreaterThanOrEqual(MIN_REFUSAL_CASES);
  });

  it('every case renders a non-empty bundle', async () => {
    const { renderBundle } = await import('../../src/bundle/render.js');
    for (const c of CASES) {
      expect(renderBundle(c.bundle).length).toBeGreaterThan(200);
    }
  });

  it('every refusal case pairs the gap screen with a date check and a judge criterion', () => {
    const refusalCases = CASES.filter(
      (c) => c.category === 'not_in_bundle' || c.rules.some((r) => r.label.includes(GAP_SCREEN_LABEL_SUBSTRING)),
    );
    expect(refusalCases.length).toBeGreaterThanOrEqual(MIN_REFUSAL_CASES);
    for (const c of refusalCases) {
      expect(
        c.rules.some((r) => r.label.includes(DATE_CHECK_LABEL_SUBSTRING)),
        `${c.id} needs mustNotInventDate`,
      ).toBe(true);
      expect(c.judge, `${c.id} needs a judge criterion`).toBeTruthy();
    }
  });

  it('the mirrored comment collapses when the rich bundle is rendered', async () => {
    const { richBundle } = await import('./bundles.js');
    const { renderBundle } = await import('../../src/bundle/render.js');
    const rendered = renderBundle(richBundle);
    expect(rendered).toContain('[comentário zendesk 90003] [espelhado do Jira AGL-900]');
    // The collapsed pointer must replace the body, not sit alongside a second full copy of it.
    const occurrences = rendered.split('14 casos de teste executados').length - 1;
    expect(occurrences).toBe(1);
  });
});

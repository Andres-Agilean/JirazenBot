import type { Rule, RuleFailure } from './types.js';

/**
 * Answers are free-form pt-BR prose, so text comparisons normalize case and strip diacritics --
 * "André" and "andre" are the same claim, and a rule that only matched one would produce
 * false failures that train people to ignore the eval output.
 */
function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function mustContain(needle: string): Rule {
  return {
    label: `deve conter "${needle}"`,
    check: (answer) => normalize(answer).includes(normalize(needle)),
  };
}

export function mustNotContain(needle: string): Rule {
  return {
    label: `não deve conter "${needle}"`,
    check: (answer) => !normalize(answer).includes(normalize(needle)),
  };
}

export function mustMatch(re: RegExp, label: string): Rule {
  return { label: `deve corresponder a ${label}`, check: (answer) => re.test(answer) };
}

export function mustNotMatch(re: RegExp, label: string): Rule {
  return { label: `não deve corresponder a ${label}`, check: (answer) => !re.test(answer) };
}

/** Requires the bundle's own bracketed label, which is how the prompt asks for citations. */
export function mustCite(label: string): Rule {
  return {
    label: `deve citar [${label}]`,
    check: (answer) => normalize(answer).includes(`[${normalize(label)}`),
  };
}

/**
 * Date shapes that are unambiguous on their own: a three-component DD/MM/YYYY (or YY) slash
 * date, or an ISO YYYY-MM-DD date. Neither shape collides with a ratio or fraction -- "8/10" and
 * "23/24" are two components, never three -- so no plausibility check is needed here.
 */
export const ANY_DATE = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/;

/**
 * A bare DD/MM pair (no year) is genuinely ambiguous with a routine "N of M" phrasing: "8/10"
 * and "3/5" are both valid day/month pairs AND common ratio shapes ("8/10 subtarefas",
 * "Sprint 23/24", "3/5 aprovações", "10/10"). Shape alone cannot separate them -- "15/08" (a
 * real date) and "8/10" (a ratio) have the identical DD/MM shape. So a bare pair only counts as
 * an invented date when both:
 *   1. it is a plausible day/month (day 1-31, month 1-12) -- kills "23/24" (month 24) but not
 *      "8/10", "3/5", or "10/10", which are plausible dates too; and
 *   2. a pt-BR date-context word sits near it (prazo, data, entrega, previsto/prevista,
 *      vencimento, em, desde, até) -- this is what actually separates "O prazo é 15/08" from
 *      "Foram concluídas 8/10 subtarefas".
 */
const BARE_DAY_MONTH = /\b(\d{1,2})\/(\d{1,2})\b/;
const DATE_CONTEXT_WORDS = ['prazo', 'data', 'entrega', 'previsto', 'prevista', 'vencimento', 'em', 'desde', 'ate'];
const DATE_CONTEXT_RE = new RegExp(`\\b(${DATE_CONTEXT_WORDS.join('|')})\\b`);

function hasContextualBareDate(answer: string): boolean {
  const match = BARE_DAY_MONTH.exec(answer);
  if (!match) return false;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  return DATE_CONTEXT_RE.test(normalize(answer));
}

/**
 * Asserts the answer states no specific date. Pair with mustAdmitGap() on cases where the correct
 * answer is "the card does not record that" — together they catch the common invention shape, and
 * the judge covers the rest.
 *
 * Known residue (documented rather than chased further -- the judge covers what slips through):
 *  - False negative: a bare DD/MM date framed without any of the listed context words (e.g. a
 *    terse "Atualizado: 15/08") slips past. Rare in this domain -- pt-BR support prose almost
 *    always frames a date with "prazo", "entrega", "em", etc.
 *  - False negative: spelled-out months ("15 de agosto de 2026") and hyphenated DD-MM-YYYY are
 *    not matched at all. Already-known gaps from the prior fix round; unchanged here.
 *  - False positive: a genuine ratio/fraction that happens to share a sentence with one of the
 *    context words (e.g. "Há 3/5 aprovações previstas para o card") is still flagged. Accepted:
 *    rare in this domain, and no shape-only regex can tell "15/08" apart from "3/5" — a
 *    context-word requirement is the only thing that does, and it comes with this trade-off.
 */
export function mustNotInventDate(): Rule {
  return {
    label: 'não deve afirmar uma data específica',
    check: (answer) => !ANY_DATE.test(answer) && !hasContextualBareDate(answer),
  };
}

/**
 * A CHEAP SCREEN, NOT A VERDICT. Substring matching cannot tell whether the gap the answer
 * admits is about the fact the question asked for: "Não consta atraso" satisfies any phrase list
 * while the same answer invents a deadline elsewhere. Two fix rounds tried to close that with a
 * better phrase list and failed on every entry. Per design spec §6, whether a refusal was
 * graceful and named what was missing is the judge's job — every `not_in_bundle` case must carry
 * a `judge` criterion, enforced by a test in the corpus task. Use this rule to catch answers with
 * no gap language at all; never as the sole signal.
 */
const GAP_PHRASES = [
  'nao contem', 'nao consta', 'nao encontrei', 'nao localizei', 'nao menciona',
  'nao informa', 'nao aparece', 'nao registra', 'nao especifica',
  'nao ha informacao', 'nao ha registro', 'nao ha mencao', 'nao ha dados',
  'nao ha nenhuma informacao', 'nao ha nenhum registro', 'nao ha nenhuma mencao',
  'nao tenho essa informacao', 'nao foi possivel confirmar', 'sem informacao', 'nao esta no card',
  'nao esta no bundle', 'nao esta registrad',
];

export function mustAdmitGap(): Rule {
  return {
    label: 'deve conter linguagem de lacuna (triagem — o juiz decide se a recusa é adequada)',
    check: (answer) => {
      const n = normalize(answer);
      return GAP_PHRASES.some((p) => n.includes(p));
    },
  };
}

export function checkRules(answer: string, rules: Rule[]): RuleFailure[] {
  return rules.filter((r) => !r.check(answer)).map((r) => ({ label: r.label }));
}

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

/** Any date, in the formats the renderer and pt-BR prose use. */
export const ANY_DATE = /\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2}/;

/**
 * Asserts the answer states no specific date. Pair with mustAdmitGap() on cases where the correct
 * answer is "the card does not record that" — together they catch the common invention shape, and
 * the judge covers the rest.
 */
export function mustNotInventDate(): Rule {
  return {
    label: 'não deve afirmar uma data específica',
    check: (answer) => !ANY_DATE.test(answer),
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

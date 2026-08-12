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
 * pt-BR phrasings that count as admitting the bundle does not answer the question. Kept
 * deliberately broad: the eval asserts the model DISCLOSED a gap, not that it used one wording.
 * Every phrase ties negation to information availability, never bare negation.
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
    label: 'deve admitir que a informação não está no bundle',
    check: (answer) => {
      const n = normalize(answer);
      return GAP_PHRASES.some((p) => n.includes(p));
    },
  };
}

export function checkRules(answer: string, rules: Rule[]): RuleFailure[] {
  return rules.filter((r) => !r.check(answer)).map((r) => ({ label: r.label }));
}

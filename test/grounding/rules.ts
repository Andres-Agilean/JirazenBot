import { renderBundle } from '@/bundle/render.js';
import type { CardBundle } from '@/bundle/types.js';
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
 * "23/24" are two components, never three -- so no plausibility check is needed here. Kept as
 * separate capturing regexes (not one alternation) so callers can pull out the matched
 * day/month/year components to compare against the bundle's own dates.
 *
 * Deliberately no trailing `\b`: every bundle timestamp is `YYYY-MM-DDThh:mm:ss...`, and `\b`
 * never matches between a digit and a letter (both are word characters), so a trailing boundary
 * would silently stop this from ever matching the date portion of a real ISO timestamp. The
 * leading `\b` is kept, to avoid matching out of the middle of a longer digit run.
 */
const FULL_DMY_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
const FULL_ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})/g;

/**
 * A bare DD/MM pair (no year) is genuinely ambiguous with a routine "N of M" phrasing: "8/10"
 * and "3/5" are both valid day/month pairs AND common ratio shapes ("8/10 subtarefas",
 * "Sprint 23/24", "3/5 aprovações", "10/10"). Shape alone cannot separate them -- "15/08" (a
 * real date) and "8/10" (a ratio) have the identical DD/MM shape. So a bare pair only counts as
 * an invented date when both:
 *   1. it is a plausible day/month (day 1-31, month 1-12) -- kills "23/24" (month 24) but not
 *      "8/10", "3/5", or "10/10", which are plausible dates too; and
 *   2. a pt-BR date-context word sits in the SAME SENTENCE -- this is what actually separates
 *      "O prazo é 15/08" from "Foram concluídas 8/10 subtarefas". Scoping to the sentence
 *      matters: over a whole answer, one stray "prazo" re-admits every ratio in the text
 *      ("O prazo não consta. Foram concluídas 8/10 subtarefas.").
 */

/** Bare day/month pair, e.g. "15/08". Global: an answer can contain several. */
const BARE_DAY_MONTH = /\b(\d{1,2})\/(\d{1,2})\b/g;

/** Sentence terminators used to bound how far a date-context word may sit from a candidate. */
const SENTENCE_SPLIT = /[.!?;\n]+/;

/**
 * Words that mark a nearby number as a date rather than a ratio. Deliberately excludes the
 * prepositions `em` / `desde` / `até`: they are common enough in ordinary prose that including
 * them flags any sentence that happens to contain a ratio.
 */
const DATE_CONTEXT_RE = /\b(prazo|data|entrega|previst[oa]|vencimento|agendad[oa]|marcad[oa]|venc[ea])\b/;

/** Plausible calendar bounds for a bare DD/MM pair. */
const MIN_DAY = 1;
const MAX_DAY = 31;
const MIN_MONTH = 1;
const MAX_MONTH = 12;

/** Zero-pads a 1-2 digit day/month/year-fragment to a fixed width, e.g. pad(8, 2) -> "08". */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Every date-shaped token the bundle itself contains, rendered through the real renderBundle()
 * (never hand-duplicated) so the harvested set can never drift from what the model actually
 * sees. For each ISO `YYYY-MM-DD` token found anywhere in the rendered bundle -- a field, a
 * comment timestamp, `fetched_at`, a history line -- this also derives its pt-BR `DD/MM` and
 * `DD/MM/YYYY` renderings, since the system prompt asks the model to write pt-BR prose and a
 * model that writes "12/08" for a bundle date of "2026-08-12" is citing the bundle correctly,
 * not inventing.
 */
function harvestBundleDates(bundle: CardBundle): Set<string> {
  const rendered = renderBundle(bundle);
  const known = new Set<string>();
  for (const match of rendered.matchAll(FULL_ISO_DATE)) {
    const [iso, year, month, day] = match;
    known.add(iso);
    known.add(`${day}/${month}`);
    known.add(`${day}/${month}/${year}`);
  }
  return known;
}

function hasContextualBareDate(answer: string, known: Set<string>): boolean {
  const normalized = normalize(answer);
  for (const sentence of normalized.split(SENTENCE_SPLIT)) {
    if (!DATE_CONTEXT_RE.test(sentence)) continue;
    for (const match of sentence.matchAll(BARE_DAY_MONTH)) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      if (day < MIN_DAY || day > MAX_DAY || month < MIN_MONTH || month > MAX_MONTH) continue;
      if (!known.has(`${pad(day, 2)}/${pad(month, 2)}`)) return true;
    }
  }
  return false;
}

/** A full DD/MM/YYYY (or YY) date not present -- in any pt-BR/ISO rendering -- in the bundle. */
function hasUnknownFullSlashDate(answer: string, known: Set<string>): boolean {
  for (const match of answer.matchAll(FULL_DMY_DATE)) {
    const [, day, month, year] = match;
    const y4 = year.length === 2 ? `20${year}` : year;
    if (!known.has(`${pad(Number(day), 2)}/${pad(Number(month), 2)}/${y4}`)) return true;
  }
  return false;
}

/** A full ISO date not present in the bundle. */
function hasUnknownIsoDate(answer: string, known: Set<string>): boolean {
  for (const match of answer.matchAll(FULL_ISO_DATE)) {
    if (!known.has(match[0])) return true;
  }
  return false;
}

/**
 * Asserts the answer states no date that isn't already in the bundle it was given. Pair with
 * mustAdmitGap() on cases where the correct answer is "the card does not record that" --
 * together they catch the common invention shape, and the judge covers the rest.
 *
 * This is bundle-aware, not a blanket "no date shape at all" ban: the system prompt itself
 * *requires* citing the bundle's `fetched_at` when answering about current status (spec §5), so
 * a rule that flagged every date shape unconditionally would fail a maximally-grounded answer
 * for doing exactly what it was told to do. "Invented" means "not present in the context" --
 * the bundle is available wherever a case is defined, so this rule takes it as a parameter and
 * checks membership instead of banning the shape outright.
 *
 * Known residue (documented rather than chased further -- the judge covers what slips through):
 *  - False positive: a genuine ratio that shares a sentence with a date-context word AND
 *    happens to coincide with a plausible day/month that is NOT in the bundle (e.g. "Há 3/5
 *    aprovações previstas para o card" when the bundle has no 03/05 date) is still flagged.
 *    Accepted: no shape-only regex can tell "15/08" apart from "3/5", so a context word plus
 *    bundle membership is the best available discriminator.
 *  - False negative: a bare DD/MM with no date-context word in its own sentence (e.g. a terse
 *    "Atualizado: 15/08") is not flagged even if 15/08 is not in the bundle -- the same sentence
 *    scoping that fixes the ratio case is what lets this one through.
 *  - False negative: spelled-out months ("15 de agosto de 2026") and hyphenated DD-MM-YYYY are
 *    not matched at all.
 */
export function mustNotInventDate(bundle: CardBundle): Rule {
  const known = harvestBundleDates(bundle);
  return {
    label: 'não deve afirmar uma data específica que não está no bundle',
    check: (answer) =>
      !hasUnknownFullSlashDate(answer, known) &&
      !hasUnknownIsoDate(answer, known) &&
      !hasContextualBareDate(answer, known),
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
    kind: 'screen',
    check: (answer) => {
      const n = normalize(answer);
      return GAP_PHRASES.some((p) => n.includes(p));
    },
  };
}

export function checkRules(answer: string, rules: Rule[]): RuleFailure[] {
  return rules.filter((r) => !r.check(answer)).map((r) => ({ label: r.label, kind: r.kind }));
}

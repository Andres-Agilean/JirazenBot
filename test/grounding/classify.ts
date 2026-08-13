import { checkRules } from './rules.js';
import type { EvalCase, RuleFailure } from './types.js';

/** The rule-based verdict for one case's answer, before any (network-bound) judge call. */
export interface ClassifyResult {
  /** Whether every non-screen rule passed. Never reflects a judge verdict -- run.ts ANDs that
   * in separately, since judging requires a live API call and this function must stay pure. */
  ok: boolean;
  /** Screen-kind rule failures (see Rule.kind in types.ts): printed for a human, never counted. */
  warnings: RuleFailure[];
  /** Non-screen rule failures: these alone determine `ok`. */
  ruleFailures: RuleFailure[];
}

/**
 * Pure, offline classification of one case's already-generated answer against its rules. Kept in
 * its own module (no top-level execution, no network) so it can be unit tested directly --
 * unlike run.ts, which executes the live eval on import and has no exports.
 */
export function classifyCase(answerText: string, c: EvalCase): ClassifyResult {
  const ruleResults = checkRules(answerText, c.rules);
  const warnings = ruleResults.filter((f) => f.kind === 'screen');
  const ruleFailures = ruleResults.filter((f) => f.kind !== 'screen');
  return { ok: ruleFailures.length === 0, warnings, ruleFailures };
}

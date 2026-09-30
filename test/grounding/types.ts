import type { CardBundle } from '@/bundle/types.js';
import type { CardCandidate } from '@/teams/search.js';

export type EvalCategory =
  | 'not_in_bundle'
  | 'retrieval'
  | 'history'
  | 'said_vs_recorded'
  | 'visibility'
  | 'degraded'
  | 'style'
  | 'portfolio';

/**
 * A deterministic, offline-checkable expectation about an answer's text.
 *
 * `kind` is the typed contract between a rule and the runner (run.ts): `'screen'` marks a rule
 * that is a cheap heuristic, not a verdict (see mustAdmitGap() in rules.ts) -- its failures are
 * printed as a warning for a human to notice, never counted against the case's pass/fail or the
 * process exit code. Absent (or `'failure'`) is the default: any other rule failure is a real
 * failure. Keeping this on the type, rather than matching a substring of the human-readable
 * label, means changing a rule's wording can never silently flip it into (or out of) a hard
 * failure.
 */
export interface Rule {
  label: string;
  kind?: 'screen' | 'failure';
  check(answer: string): boolean;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  /**
   * Required even for portfolio cases (which ignore it) so the 33 card cases and the offline
   * "every case renders a non-empty bundle" check keep their types; portfolio cases pass a
   * shared dummy (see PORTFOLIO_DUMMY_BUNDLE in cases.ts).
   */
  bundle: CardBundle;
  /**
   * When set, the answer comes from the portfolio path (answerPortfolio over renderPortfolio)
   * instead of the single-card path, and `bundle` is ignored.
   */
  portfolio?: { name: string; cards: CardCandidate[]; total: number; nowMs: number };
  question: string;
  rules: Rule[];
  /**
   * Present only where a rule cannot express the expectation — typically "did it refuse
   * gracefully and name what was missing, rather than hedge or invent?". Phrased as a yes/no
   * question for the judge.
   */
  judge?: string;
}

export interface RuleFailure {
  label: string;
  kind?: 'screen' | 'failure';
}

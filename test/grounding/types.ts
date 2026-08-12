import type { CardBundle } from '../../src/bundle/types.js';

export type EvalCategory =
  | 'not_in_bundle'
  | 'retrieval'
  | 'history'
  | 'said_vs_recorded'
  | 'visibility'
  | 'degraded';

/** A deterministic, offline-checkable expectation about an answer's text. */
export interface Rule {
  label: string;
  check(answer: string): boolean;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  bundle: CardBundle;
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
}

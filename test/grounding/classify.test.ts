import { describe, expect, it } from 'vitest';
import { classifyCase } from './classify.js';
import { mustAdmitGap, mustContain } from './rules.js';
import type { EvalCase } from './types.js';
import { sparseBundle } from './bundles.js';

/** Minimal case fixture -- only `rules` varies between tests below. */
function caseWith(rules: EvalCase['rules']): EvalCase {
  return {
    id: 'fixture-case',
    category: 'not_in_bundle',
    bundle: sparseBundle,
    question: 'pergunta de teste',
    rules,
  };
}

describe('classifyCase', () => {
  it('is ok, with a warning, when only a screen rule fails', () => {
    // mustAdmitGap() is kind: 'screen' -- its failure must never flip `ok` to false on its own.
    const result = classifyCase('O responsável é o Bruno Tavares.', caseWith([mustAdmitGap()]));
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.ruleFailures).toHaveLength(0);
  });

  it('is not ok when a hard (non-screen) rule fails', () => {
    const result = classifyCase('Texto qualquer.', caseWith([mustContain('André Marques')]));
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.ruleFailures).toHaveLength(1);
  });

  it('is not ok when both a screen and a hard rule fail, and still reports the warning', () => {
    const result = classifyCase(
      'Texto qualquer, sem lacuna admitida.',
      caseWith([mustAdmitGap(), mustContain('André Marques')]),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.ruleFailures).toHaveLength(1);
  });

  it('is ok, with no warnings, when every rule passes', () => {
    const result = classifyCase('Não há registro disso no card.', caseWith([mustAdmitGap()]));
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.ruleFailures).toHaveLength(0);
  });
});

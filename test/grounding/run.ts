import 'dotenv/config';
import { loadConfig } from '../../src/config.js';
import { createAnthropicClient } from '../../src/claude/client.js';
import { answer, type AnswerDeps } from '../../src/claude/answer.js';
import { checkRules } from './rules.js';
import { judge } from './judge.js';
import { CASES } from './cases.js';
import type { RuleFailure } from './types.js';

/**
 * Substring shared by every rule label produced by mustAdmitGap() (rules.ts). That function is
 * documented there, in five rounds of review, as "a screen, not a verdict": its phrase list
 * false-negatives on plainly correct pt-BR refusals (e.g. "Não há chamado Zendesk vinculado a
 * este card.") that just don't happen to use one of its listed phrasings. Per design spec §6,
 * whether a refusal was graceful and named the right gap is the JUDGE's call, not this screen's.
 * So a rule whose label carries this marker may only ever produce a WARNING here -- printed for
 * a human to notice, never counted against the case's pass/fail or the process exit code. Every
 * other rule failure, and every failed judge criterion, is a real FAILURE.
 */
const SCREEN_LABEL_MARKER = 'triagem';

const EXIT_CASE_FAILURES = 1;
const EXIT_NO_MATCHING_CASES = 2;
const EXIT_SETUP_ERROR = 3;

function isScreenWarning(f: RuleFailure): boolean {
  return f.label.includes(SCREEN_LABEL_MARKER);
}

/**
 * Everything that can throw -- config loading (missing/invalid env), client construction
 * (missing ANTHROPIC_API_KEY), and every Claude call -- runs inside this function so main() can
 * report a bare, pt-BR error message instead of a raw Node stack trace or an SDK exception dump.
 * That matters most for the missing-key case: with no key configured, this is the path every
 * `npm run eval` invocation takes until Task 8 wires up a real key.
 */
async function runEval(): Promise<void> {
  const useJudge = process.argv.includes('--judge');
  const only = (() => {
    const i = process.argv.indexOf('--only');
    return i >= 0 ? process.argv[i + 1] : null;
  })();

  const cfg = loadConfig();
  const deps: AnswerDeps = {
    client: createAnthropicClient(cfg),
    model: cfg.claudeModel,
    maxTokens: cfg.claudeMaxTokens,
  };

  const cases = only ? CASES.filter((c) => c.id.includes(only)) : CASES;
  if (cases.length === 0) {
    console.error(`Nenhum caso corresponde a "${only}".`);
    process.exitCode = EXIT_NO_MATCHING_CASES;
    return;
  }

  let passed = 0;
  let warnedCases = 0;
  const failures: string[] = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const c of cases) {
    const a = await answer(c.bundle, c.question, [], deps);
    totals.input += a.usage.input;
    totals.output += a.usage.output;
    totals.cacheRead += a.usage.cacheRead;
    totals.cacheWrite += a.usage.cacheWrite;

    const ruleResults = checkRules(a.text, c.rules);
    const warnings = ruleResults.filter(isScreenWarning);
    const ruleFailures = ruleResults.filter((f) => !isScreenWarning(f));

    let judgeFailure: string | null = null;
    if (useJudge && c.judge) {
      const verdict = await judge(c.question, a.text, c.judge, deps);
      if (!verdict.pass) judgeFailure = verdict.reason;
    }

    if (warnings.length > 0) warnedCases++;

    const ok = ruleFailures.length === 0 && judgeFailure === null;
    if (ok) {
      passed++;
      console.log(`✅ ${c.id}`);
    } else {
      console.log(`❌ ${c.id}`);
      for (const f of ruleFailures) console.log(`     regra: ${f.label}`);
      if (judgeFailure) console.log(`     juiz: ${judgeFailure}`);
      failures.push(`${c.id}\n  pergunta: ${c.question}\n  resposta: ${a.text}`);
    }
    // Printed regardless of ok/failure above, so a screen miss on an otherwise-passing case is
    // still visible to a human reading the report -- it never affects passed/failures/exitCode.
    for (const w of warnings) console.log(`     aviso (triagem, não conta como falha): ${w.label}`);
  }

  console.log(`\n${passed}/${cases.length} aprovados (${warnedCases} aviso(s) de triagem)`);
  console.log(
    `tokens: entrada ${totals.input} | saída ${totals.output} | ` +
      `cache lido ${totals.cacheRead} | cache escrito ${totals.cacheWrite}`,
  );

  if (failures.length > 0) {
    console.log('\n--- falhas ---');
    for (const f of failures) console.log(`\n${f}`);
    process.exitCode = EXIT_CASE_FAILURES;
  }
}

try {
  await runEval();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = EXIT_SETUP_ERROR;
}

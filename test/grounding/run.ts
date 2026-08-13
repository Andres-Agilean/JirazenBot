import 'dotenv/config';
import { loadConfig } from '@/config.js';
import { createAnthropicClient } from '@/claude/client.js';
import { answer, type AnswerDeps } from '@/claude/answer.js';
import type { Usage } from '@/claude/types.js';
import { classifyCase } from './classify.js';
import { judge } from './judge.js';
import { CASES } from './cases.js';
import { parseOnly } from './argv.js';

const EXIT_CASE_FAILURES = 1;
const EXIT_NO_MATCHING_CASES = 2;
const EXIT_SETUP_ERROR = 3;
// A case whose answer()/judge() call threw (a model returning no text, a transient API error,
// etc.) rather than one that ran and produced a rule/judge failure. Kept distinct from
// EXIT_CASE_FAILURES so a human can tell "the model was wrong" apart from "the run itself broke
// partway through" -- see the exit-code precedence comment below the loop.
const EXIT_CASE_ERRORS = 4;

// Label prefix for a printed screen warning (see Rule.kind in types.ts, and classifyCase in
// classify.ts, which is what actually decides screen vs. failure now -- this is display only).
const SCREEN_WARNING_PREFIX = 'aviso (triagem, não conta como falha)';

function addUsage(totals: Usage, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
}

function formatUsage(totals: Usage): string {
  return (
    `entrada ${totals.input} | saída ${totals.output} | ` +
    `cache lido ${totals.cacheRead} | cache escrito ${totals.cacheWrite}`
  );
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
  const only = parseOnly(process.argv);
  if (only === undefined) {
    console.error(
      '--only requer um valor imediatamente após (ex.: --only nib-04) -- nenhum caso executado.',
    );
    process.exitCode = EXIT_NO_MATCHING_CASES;
    return;
  }

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
  let hardFailedCases = 0;
  let erroredCases = 0;
  const failures: string[] = [];
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const judgeTotals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const c of cases) {
    // Each case runs in its own try/catch: a throw from answer() (e.g. its own "O modelo
    // respondeu sem texto." guard) or judge() must not discard every result already computed for
    // the cases before it, nor read as a setup failure (the outer catch around runEval()) --
    // Task 7 fix review finding 2. Whatever usage was already added to `totals` before the throw
    // reflects a real, billed call and is deliberately kept, not rolled back.
    try {
      const a = await answer(c.bundle, c.question, [], deps);
      addUsage(totals, a.usage);

      const { ok: rulesOk, warnings, ruleFailures } = classifyCase(a.text, c);

      let judgeFailure: string | null = null;
      if (useJudge && c.judge) {
        const verdict = await judge(c.question, a.text, c.judge, deps);
        addUsage(judgeTotals, verdict.usage);
        if (!verdict.pass) judgeFailure = verdict.reason;
      }

      if (warnings.length > 0) warnedCases++;

      const ok = rulesOk && judgeFailure === null;
      if (ok) {
        passed++;
        console.log(`✅ ${c.id}`);
      } else {
        hardFailedCases++;
        console.log(`❌ ${c.id}`);
        for (const f of ruleFailures) console.log(`     regra: ${f.label}`);
        if (judgeFailure) console.log(`     juiz: ${judgeFailure}`);
        failures.push(`${c.id}\n  pergunta: ${c.question}\n  resposta: ${a.text}`);
      }
      // Printed regardless of ok/failure above, so a screen miss on an otherwise-passing case is
      // still visible to a human reading the report -- it never affects passed/failures/exitCode.
      for (const w of warnings) console.log(`     ${SCREEN_WARNING_PREFIX}: ${w.label}`);
    } catch (err) {
      erroredCases++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`❌ ${c.id}`);
      console.log(`     erro: ${message}`);
      failures.push(`${c.id}\n  pergunta: ${c.question}\n  erro: ${message}`);
    }
  }

  console.log(
    `\n${passed}/${cases.length} aprovados (${warnedCases} aviso(s) de triagem, ` +
      `${erroredCases} erro(s) de execução)`,
  );
  console.log(`tokens: ${formatUsage(totals)}`);
  console.log(`tokens do juiz: ${formatUsage(judgeTotals)}`);

  if (failures.length > 0) {
    console.log('\n--- falhas ---');
    for (const f of failures) console.log(`\n${f}`);
    // Precedence when a run has both kinds of trouble: a rule/judge failure (the model was
    // wrong about something) is treated as the more important signal than a thrown case (the run
    // broke), so EXIT_CASE_FAILURES wins whenever hardFailedCases > 0 -- EXIT_CASE_ERRORS only
    // surfaces when every failure in this run was a thrown error and none was a rule/judge miss.
    process.exitCode = hardFailedCases > 0 ? EXIT_CASE_FAILURES : EXIT_CASE_ERRORS;
  }
}

try {
  await runEval();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = EXIT_SETUP_ERROR;
}

import type { AnswerDeps } from '../../src/claude/answer.js';
import type { Usage } from '../../src/claude/types.js';

export interface Verdict {
  pass: boolean;
  reason: string;
  usage: Usage;
}

const JUDGE_SYSTEM = `Você avalia respostas de um bot de suporte que só pode responder com base em um card do Jira/Zendesk.

Você recebe: a pergunta feita, a resposta do bot, e um critério de avaliação.
Responda APENAS com uma linha no formato:

SIM — <justificativa em até 20 palavras>
NÃO — <justificativa em até 20 palavras>

Responda SIM somente se o critério for claramente satisfeito.`;

// Small cap: the judge produces one classification line, not an essay. Also bounds cost --
// this call runs once per case per --judge invocation, on top of the answer call itself.
const JUDGE_MAX_TOKENS = 200;

/**
 * Judges the cases a deterministic rule cannot express -- chiefly whether a refusal was
 * graceful and named what was missing, versus hedged or invented. Runs at effort low and a
 * small max_tokens: this is a one-line classification, not an essay.
 */
export async function judge(
  question: string,
  answerText: string,
  criterion: string,
  deps: AnswerDeps,
): Promise<Verdict> {
  const response = await deps.client.messages.create({
    model: deps.model,
    max_tokens: JUDGE_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: JUDGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content:
          `PERGUNTA: ${question}\n\nRESPOSTA DO BOT:\n${answerText}\n\nCRITÉRIO: ${criterion}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('')
    .trim();

  // Robust to trailing punctuation ("Sim.") and case ("sim —"): only the leading token matters,
  // never the justification that follows the dash.
  return {
    pass: /^sim\b/i.test(text),
    reason: text,
    // Flattened the same way answer() (src/claude/answer.ts) flattens response.usage, so the
    // runner can fold judge spend into the same totals shape as answer spend (Task 7 fix
    // review finding 1) -- a judge call is a real, billable call and must not go unreported.
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

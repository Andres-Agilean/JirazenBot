import { SYSTEM_PROMPT, buildMessages, CACHE_CONTROL } from './prompt.js';
import { PORTFOLIO_SYSTEM_PROMPT, buildPortfolioMessages } from './portfolioPrompt.js';
import type { AnthropicLike, Answer, Turn } from './types.js';
import type { CardBundle } from '@/bundle/types.js';

/**
 * Thinking is on but shallow: the task is question-answering over supplied context, not hard
 * reasoning, but duration questions ("há quanto tempo está bloqueado?") need light date math.
 */
export const CLAUDE_EFFORT = 'low';
const THINKING = { type: 'adaptive' } as const;

// stop_reason the SDK reports when generation was cut off by max_tokens rather than finishing
// naturally. Adaptive thinking shares the same token budget as the answer text, so a long thread
// can be truncated mid-sentence -- without a visible marker, a partial answer that lost its
// "...mas o card não registra isso" caveat reads as a confident, complete claim.
const MAX_TOKENS_STOP_REASON = 'max_tokens';

/** Appended to a truncated answer so the CLI, the eval, and Teams users can all tell it apart
 * from a complete one. Deliberately loud (all-caps marker) rather than a soft caveat. */
export const TRUNCATION_NOTICE =
  '\n\n[RESPOSTA TRUNCADA: o limite de tokens foi atingido antes do fim da resposta -- trate como incompleta.]';

export interface AnswerDeps {
  client: AnthropicLike;
  model: string;
  maxTokens: number;
}

/**
 * The one primitive (plan §3). The unfurl summary is this function called with
 * DEFAULT_SUMMARY_QUESTION; every follow-up is this function with the user's words. There is
 * deliberately no separate "summary" path.
 */
export async function answer(
  bundle: CardBundle,
  question: string,
  history: Turn[],
  deps: AnswerDeps,
): Promise<Answer> {
  return requestAnswer(SYSTEM_PROMPT, buildMessages(bundle, question, history), deps);
}

/** Portfolio Q&A: same request core as `answer`, different prompt and context. */
export async function answerPortfolio(
  rendered: string,
  question: string,
  history: Turn[],
  deps: AnswerDeps,
): Promise<Answer> {
  return requestAnswer(
    PORTFOLIO_SYSTEM_PROMPT,
    buildPortfolioMessages(rendered, question, history),
    deps,
  );
}

/** The single client call, empty-text guard and truncation marking shared by both paths. */
async function requestAnswer(
  systemPrompt: string,
  messages: unknown[],
  deps: AnswerDeps,
): Promise<Answer> {
  const response = await deps.client.messages.create({
    model: deps.model,
    max_tokens: deps.maxTokens,
    thinking: THINKING,
    output_config: { effort: CLAUDE_EFFORT },
    system: [{ type: 'text', text: systemPrompt, cache_control: CACHE_CONTROL }],
    messages,
  });

  let text = response.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('')
    .trim();

  if (text === '') {
    throw new Error('O modelo respondeu sem texto.');
  }

  // A partial answer plus a visible warning beats throwing away a real, billed response -- never
  // throw here, just mark it so nothing downstream mistakes it for a finished answer.
  if (response.stop_reason === MAX_TOKENS_STOP_REASON) {
    text += TRUNCATION_NOTICE;
  }

  return {
    text,
    model: response.model,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

import { SYSTEM_PROMPT, buildMessages } from './prompt.js';
import type { AnthropicLike, Answer, Turn } from './types.js';
import type { CardBundle } from '../bundle/types.js';

/**
 * Thinking is on but shallow: the task is question-answering over supplied context, not hard
 * reasoning, but duration questions ("há quanto tempo está bloqueado?") need light date math.
 */
export const CLAUDE_EFFORT = 'low';
const THINKING = { type: 'adaptive' } as const;
const EPHEMERAL = { type: 'ephemeral' } as const;

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
  const response = await deps.client.messages.create({
    model: deps.model,
    max_tokens: deps.maxTokens,
    thinking: THINKING,
    output_config: { effort: CLAUDE_EFFORT },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: EPHEMERAL }],
    messages: buildMessages(bundle, question, history),
  });

  const text = response.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('')
    .trim();

  if (text === '') {
    throw new Error('O modelo respondeu sem texto.');
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

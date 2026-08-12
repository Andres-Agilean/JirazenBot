import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import { requireAnthropicKey } from '../config.js';
import type { AnthropicLike, AnthropicResponse } from './types.js';

/**
 * Adapts the SDK client to the narrow AnthropicLike seam. Wrapping rather than returning the
 * SDK client directly keeps answer() independent of the SDK's overloaded types, so tests can
 * pass a plain object with no network and no API key.
 */
export function createAnthropicClient(cfg: Config): AnthropicLike {
  const sdk = new Anthropic({ apiKey: requireAnthropicKey(cfg) });
  return {
    messages: {
      async create(params) {
        // The SDK's create() is overloaded across streaming/non-streaming and beta shapes; this
        // call is always non-streaming, so the response is narrowed to what we read.
        const response = await sdk.messages.create(params as never);
        return response as unknown as AnthropicResponse;
      },
    },
  };
}

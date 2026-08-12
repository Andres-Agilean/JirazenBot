/** One prior conversation turn, oldest first. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Token accounting for one answer, flattened from the API's usage object. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Answer {
  text: string;
  model: string;
  usage: Usage;
}

/** The subset of an Anthropic message response this codebase reads. */
export interface AnthropicResponse {
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

/**
 * The narrow seam between answer() and the Anthropic SDK. Declaring the shape we depend on --
 * rather than importing the SDK's own overloaded client type -- is what lets every unit test
 * run offline against a plain object, with no network and no API key.
 */
export interface AnthropicLike {
  messages: { create(params: Record<string, unknown>): Promise<AnthropicResponse> };
}

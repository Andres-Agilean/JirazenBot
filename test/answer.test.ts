import { describe, expect, it } from 'vitest';
import { answer, TRUNCATION_NOTICE, type AnswerDeps } from '@/claude/answer.js';
import { SYSTEM_PROMPT } from '@/claude/prompt.js';
import type { AnthropicResponse, AnthropicLike } from '@/claude/types.js';
import type { CardBundle } from '@/bundle/types.js';

const bundle: CardBundle = {
  fetchedAt: '2026-08-12T10:00:00.000Z',
  surface: 'dm',
  jira: {
    issueId: '42395',
    issueKey: 'QZ-252',
    fields: { summary: 'App fecha ao tirar foto' },
    comments: [],
    statusHistory: [],
  },
  resolution: { via: 'jira_zendesk_id_field', ambiguous: false },
  truncationNotes: [],
};

function fakeClient(response: Partial<AnthropicResponse> = {}): {
  client: AnthropicLike;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const client: AnthropicLike = {
    messages: {
      async create(params) {
        calls.push(params);
        return {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'Resposta.' }],
          usage: { input_tokens: 100, output_tokens: 20 },
          ...response,
        };
      },
    },
  };
  return { client, calls };
}

const deps = (client: AnthropicLike): AnswerDeps => ({
  client,
  model: 'claude-sonnet-5',
  maxTokens: 2048,
});

describe('answer', () => {
  it('sends the system prompt with a cache breakpoint', async () => {
    const { client, calls } = fakeClient();
    await answer(bundle, 'Qual o status?', [], deps(client));
    const system = calls[0].system as any[];
    expect(system[0].text).toBe(SYSTEM_PROMPT);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('puts a cache breakpoint on the system block and the bundle block, and nowhere else', async () => {
    const { client, calls } = fakeClient();
    await answer(bundle, 'Qual o status?', [{ role: 'user', text: 'anterior' }], deps(client));

    const system = calls[0].system as Array<Record<string, unknown>>;
    const messages = calls[0].messages as Array<Record<string, unknown>>;

    // exactly the two intended breakpoints
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((messages[0].content as Array<Record<string, unknown>>)[0].cache_control).toEqual({
      type: 'ephemeral',
    });

    // and no others anywhere in the request
    expect(JSON.stringify(calls[0]).match(/"cache_control"/g)).toHaveLength(2);
  });

  it('sends the configured model, max tokens, adaptive thinking and low effort', async () => {
    const { client, calls } = fakeClient();
    await answer(bundle, 'Qual o status?', [], deps(client));
    expect(calls[0].model).toBe('claude-sonnet-5');
    expect(calls[0].max_tokens).toBe(2048);
    expect(calls[0].thinking).toEqual({ type: 'adaptive' });
    expect(calls[0].output_config).toEqual({ effort: 'low' });
  });

  it('never sends sampling parameters (Sonnet 5 rejects them)', async () => {
    const { client, calls } = fakeClient();
    await answer(bundle, 'Qual o status?', [], deps(client));
    expect(calls[0]).not.toHaveProperty('temperature');
    expect(calls[0]).not.toHaveProperty('top_p');
    expect(calls[0]).not.toHaveProperty('top_k');
  });

  it('never sends tools in this phase', async () => {
    const { client, calls } = fakeClient();
    await answer(bundle, 'Qual o status?', [], deps(client));
    expect(calls[0]).not.toHaveProperty('tools');
  });

  it('returns only text blocks, ignoring empty thinking blocks', async () => {
    const { client } = fakeClient({
      content: [
        { type: 'thinking', text: '' },
        { type: 'text', text: 'Está em teste ' },
        { type: 'text', text: '[campo Status].' },
      ],
    });
    const result = await answer(bundle, 'Qual o status?', [], deps(client));
    expect(result.text).toBe('Está em teste [campo Status].');
  });

  it('flattens usage, defaulting absent cache fields to zero', async () => {
    const { client } = fakeClient({
      usage: {
        input_tokens: 90,
        output_tokens: 20,
        cache_read_input_tokens: 2600,
        cache_creation_input_tokens: null,
      },
    });
    const result = await answer(bundle, 'Qual o status?', [], deps(client));
    expect(result.usage).toEqual({ input: 90, output: 20, cacheRead: 2600, cacheWrite: 0 });
    expect(result.model).toBe('claude-sonnet-5');
  });

  it('throws a pt-BR error when the model returns no text', async () => {
    const { client } = fakeClient({ content: [{ type: 'thinking', text: '' }] });
    await expect(answer(bundle, 'Qual o status?', [], deps(client))).rejects.toThrow(
      /sem texto/i,
    );
  });

  it('appends a visible pt-BR truncation notice when stop_reason is max_tokens', async () => {
    const { client } = fakeClient({
      content: [{ type: 'text', text: 'Está em teste desde 10/08 e' }],
      stop_reason: 'max_tokens',
    });
    const result = await answer(bundle, 'Qual o status?', [], deps(client));
    expect(result.text).toBe(`Está em teste desde 10/08 e${TRUNCATION_NOTICE}`);
    expect(result.text).toMatch(/TRUNCAD/);
  });

  it('does not append a truncation notice when stop_reason is end_turn', async () => {
    const { client } = fakeClient({
      content: [{ type: 'text', text: 'Está em teste.' }],
      stop_reason: 'end_turn',
    });
    const result = await answer(bundle, 'Qual o status?', [], deps(client));
    expect(result.text).toBe('Está em teste.');
  });
});

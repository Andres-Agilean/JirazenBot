import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, MAX_HISTORY_TURNS, buildMessages } from '@/claude/prompt.js';
import type { CardBundle } from '@/bundle/types.js';
import type { Turn } from '@/claude/types.js';

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

describe('SYSTEM_PROMPT', () => {
  it('states the grounding rules the spec requires', () => {
    expect(SYSTEM_PROMPT).toMatch(/pt-BR/);
    expect(SYSTEM_PROMPT).toContain('CARD_BUNDLE');
    expect(SYSTEM_PROMPT).toContain('fetched_at');
    expect(SYSTEM_PROMPT).toContain('espelhado do Jira');
    expect(SYSTEM_PROMPT).toContain('truncamento');
  });
});

describe('buildMessages', () => {
  it('puts the rendered bundle first, with a cache breakpoint', () => {
    const msgs = buildMessages(bundle, 'Qual o status?', []) as any[];
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content[0].text).toContain('<CARD_BUNDLE>');
    expect(msgs[0].content[0].text).toContain('QZ-252');
    expect(msgs[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('puts the question last, with no cache breakpoint on it', () => {
    const msgs = buildMessages(bundle, 'Qual o status?', []) as any[];
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe('Qual o status?');
    expect(last.cache_control).toBeUndefined();
  });

  it('places history between the bundle and the question, in order', () => {
    const history: Turn[] = [
      { role: 'user', text: 'quem validou?' },
      { role: 'assistant', text: 'André Marques.' },
    ];
    const msgs = buildMessages(bundle, 'e quando?', history) as any[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
    expect(msgs[1].content).toBe('quem validou?');
    expect(msgs[2].content).toBe('André Marques.');
    expect(msgs[3].content).toBe('e quando?');
  });

  it('keeps only the most recent MAX_HISTORY_TURNS turns', () => {
    const history: Turn[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as Turn['role'],
      text: `t${i}`,
    }));
    const msgs = buildMessages(bundle, 'agora?', history) as any[];
    // 1 bundle + 6 history + 1 question
    expect(msgs).toHaveLength(1 + MAX_HISTORY_TURNS + 1);
    expect(msgs[1].content).toBe('t4'); // t0..t3 dropped
    expect(msgs[MAX_HISTORY_TURNS].content).toBe('t9');
  });

  it('renders a byte-identical cached prefix for the same bundle across questions and history (spec §4)', () => {
    // Prefix byte-stability is what makes the prompt cache pay off across a conversation's turns;
    // this proves the claim instead of leaving it asserted only in prose.
    const history: Turn[] = [
      { role: 'user', text: 'Quem validou?' },
      { role: 'assistant', text: 'Carla Nunes [comentário jira 70003].' },
    ];
    const q1 = buildMessages(bundle, 'Quem validou?', []) as any[];
    const q2 = buildMessages(bundle, 'E quando foi movido para Em Teste?', history) as any[];
    expect(JSON.stringify(q2[0])).toBe(JSON.stringify(q1[0]));
  });
});

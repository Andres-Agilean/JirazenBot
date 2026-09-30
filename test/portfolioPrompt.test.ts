import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_TURNS } from '@/claude/prompt.js';
import { PORTFOLIO_SYSTEM_PROMPT, buildPortfolioMessages } from '@/claude/portfolioPrompt.js';
import type { Turn } from '@/claude/types.js';
import { CARD_FETCH_CAP } from '@/fetch/zendesk.js';

const RENDERED = '[estatísticas]\ntotal: 3\n[atividades]\nQZ-306 | Em Teste';

describe('PORTFOLIO_SYSTEM_PROMPT', () => {
  it('states the grounding rules', () => {
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('[estatísticas]');
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('[atividades]');
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('NUNCA calcule');
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('[QZ-306]');
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('[chamado 17063]');
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain(`"${CARD_FETCH_CAP}+"`);
    expect(PORTFOLIO_SYSTEM_PROMPT).toMatch(/pt-BR/);
  });

  it('states the style contract', () => {
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('negrito');
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('no máximo 3 marcadores');
    expect(PORTFOLIO_SYSTEM_PROMPT).toContain('Nunca use cabeçalhos, tabelas ou blocos de código');
  });
});

describe('buildPortfolioMessages', () => {
  it('puts the rendered context first, cached for one hour', () => {
    const msgs = buildPortfolioMessages(RENDERED, 'Quantos abertos?', []) as any[];
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content[0].text).toBe(RENDERED);
    expect(msgs[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('puts the question last and history in order between', () => {
    const history: Turn[] = [
      { role: 'user', text: 'p1' },
      { role: 'assistant', text: 'r1' },
    ];
    const msgs = buildPortfolioMessages(RENDERED, 'p2', history) as any[];
    expect(msgs.map((m) => m.content)).toEqual([expect.any(Array), 'p1', 'r1', 'p2']);
    expect(msgs[1].role).toBe('user');
    expect(msgs[2].role).toBe('assistant');
    expect(msgs[3].role).toBe('user');
  });

  it('keeps only the most recent MAX_HISTORY_TURNS turns', () => {
    const history: Turn[] = Array.from({ length: MAX_HISTORY_TURNS + 4 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `t${i}`,
    }));
    const msgs = buildPortfolioMessages(RENDERED, 'q', history) as any[];
    expect(msgs).toHaveLength(1 + MAX_HISTORY_TURNS + 1);
    expect(msgs[1].content).toBe('t4');
  });

  it('has a byte-stable prefix across different questions', () => {
    const a = buildPortfolioMessages(RENDERED, 'primeira', []) as any[];
    const b = buildPortfolioMessages(RENDERED, 'segunda', []) as any[];
    expect(JSON.stringify(a[0])).toBe(JSON.stringify(b[0]));
    expect(a[1].content).not.toBe(b[1].content);
  });
});

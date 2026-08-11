import { describe, expect, it } from 'vitest';
import { applyBudget, estimateTokens } from '../src/bundle/budget.js';
import { renderBundle } from '../src/bundle/render.js';
import type { CardBundle } from '../src/bundle/types.js';

function pathological(): CardBundle {
  const comments = Array.from({ length: 200 }, (_, i) => ({
    id: i + 1,
    author: `Agente ${i}`,
    isPublic: i % 3 !== 0,
    createdAt: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    body: `resposta ${i}\n` + '> citação de email antigo\n'.repeat(300),
  }));
  return {
    fetchedAt: '2026-08-10T18:00:00.000Z',
    surface: 'dm',
    zendesk: {
      ticketId: '16467', subject: 'thread patológica', status: 'open', priority: null,
      createdAt: '2026-06-01T10:00:00Z', updatedAt: '2026-08-10T10:00:00Z',
      comments, internalNotesOmitted: false,
    },
    jira: {
      issueId: '42395', issueKey: 'QZ-252',
      fields: { summary: 'caso patológico' },
      comments: [],
      statusHistory: Array.from({ length: 60 }, (_, i) => ({
        field: 'status' as const, from: `E${i}`, to: `E${i + 1}`,
        at: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`, by: 'Automation',
      })),
    },
    resolution: { via: 'zendesk_links', ambiguous: false },
    truncationNotes: [],
  };
}

describe('estimateTokens', () => {
  it('estimates chars/4 rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('applyBudget', () => {
  it('leaves small bundles untouched', () => {
    const b = pathological();
    const small: CardBundle = { ...b, zendesk: { ...b.zendesk!, comments: b.zendesk!.comments.slice(0, 2) }, jira: undefined };
    const out = applyBudget(small, 25000);
    expect(out.truncationNotes).toEqual([]);
    expect(out.zendesk?.comments).toHaveLength(2);
  });

  it('brings a pathological 200-comment bundle under budget, keeping required elements', () => {
    const original = pathological();
    const out = applyBudget(original, 25000);
    const rendered = renderBundle(out);
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(25000);
    // required: first + 10 most recent Zendesk comments survive
    const ids = out.zendesk!.comments.map((c) => c.id);
    expect(ids).toContain(1);
    for (const recent of original.zendesk!.comments.slice(-10)) expect(ids).toContain(recent.id);
    // the 10 most recent bodies are not shortened
    for (const c of out.zendesk!.comments.slice(-10)) expect(c.body).not.toContain('[truncado]');
    // fields survive untouched
    expect(out.jira?.fields.summary).toBe('caso patológico');
    // history capped at 20
    expect(out.jira?.statusHistory.length).toBeLessThanOrEqual(20);
    // disclosure present
    expect(out.truncationNotes.length).toBeGreaterThan(0);
    expect(rendered).toContain('truncamento:');
    // original untouched (pure function)
    expect(original.zendesk!.comments).toHaveLength(200);
  });
});

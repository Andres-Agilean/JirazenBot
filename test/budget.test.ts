import { describe, expect, it } from 'vitest';
import { applyBudget, estimateTokens } from '@/bundle/budget.js';
import { renderBundle } from '@/bundle/render.js';
import { BUDGET_EXCEEDED_NOTE } from '@/bundle/notes.js';
import type { CardBundle } from '@/bundle/types.js';

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
    // disclosure present
    expect(out.truncationNotes.length).toBeGreaterThan(0);
    expect(rendered).toContain('truncamento:');
    // original untouched (pure function)
    expect(original.zendesk!.comments).toHaveLength(200);
  });

  it('caps status history to the 20 most recent transitions when comment truncation alone cannot meet budget', () => {
    const N = 400;
    const PAD = 100;
    const statusHistory = Array.from({ length: N }, (_, i) => ({
      field: 'status' as const,
      from: `Estado-Longo-Numero-${i}-` + 'x'.repeat(PAD),
      to: `Estado-Longo-Numero-${i + 1}-` + 'y'.repeat(PAD),
      at: `2026-0${(i % 6) + 1}-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      by: 'Automation',
    }));
    // Few, short comments: steps 1 and 2 have nothing to do (fewer than 1 + KEEP_RECENT comments,
    // and each body is well under the 1500-char shortening threshold), so only step 3 can shrink this.
    const comments = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      author: `Agente ${i}`,
      isPublic: true,
      createdAt: '2026-06-01T10:00:00Z',
      body: `resposta curta ${i}`,
    }));
    const bundle: CardBundle = {
      fetchedAt: '2026-08-10T18:00:00.000Z',
      surface: 'dm',
      zendesk: {
        ticketId: '16467', subject: 'thread histórico', status: 'open', priority: null,
        createdAt: '2026-06-01T10:00:00Z', updatedAt: '2026-08-10T10:00:00Z',
        comments, internalNotesOmitted: false,
      },
      jira: {
        issueId: '42395', issueKey: 'QZ-252',
        fields: { summary: 'caso histórico' },
        comments: [],
        statusHistory,
      },
      resolution: { via: 'zendesk_links', ambiguous: false },
      truncationNotes: [],
    };
    const budget = 25000;

    const out = applyBudget(bundle, budget);
    const rendered = renderBundle(out);
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(budget);
    expect(out.jira!.statusHistory.length).toBeLessThanOrEqual(20);
    // retained transitions are the most recent ones from the input, in order
    expect(out.jira!.statusHistory).toEqual(bundle.jira!.statusHistory.slice(-20));
    expect(out.truncationNotes.some((n) => n.includes('histórico'))).toBe(true);
  });

  it('discloses when a single huge Jira comment leaves the bundle over budget after all truncation steps', () => {
    // Jira comment bodies are never shortened (step 1 is Zendesk-only) and a lone comment is
    // never dropped by step 2 (it is simultaneously "the first" and one of the 10 most recent),
    // so this bundle stays over budget through all three steps -- the note must still appear.
    const budget = 100;
    const bundle: CardBundle = {
      fetchedAt: '2026-08-10T18:00:00.000Z',
      surface: 'dm',
      jira: {
        issueId: '42395', issueKey: 'QZ-252',
        fields: { summary: 'comentário gigante' },
        comments: [{
          id: '1',
          author: 'Automation for Jira',
          createdAt: '2026-08-01T10:00:00Z',
          body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] },
        }],
        statusHistory: [],
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    };
    const out = applyBudget(bundle, budget);
    expect(estimateTokens(renderBundle(out))).toBeGreaterThan(budget);
    expect(out.truncationNotes).toContain(BUDGET_EXCEEDED_NOTE);
    expect(renderBundle(out)).toContain('truncamento:');
  });
});

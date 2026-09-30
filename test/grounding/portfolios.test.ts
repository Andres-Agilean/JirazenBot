import { describe, expect, it } from 'vitest';
import { computeAggregates, renderPortfolio } from '@/teams/portfolio.js';
import { mustNotInventDateIn } from './rules.js';
import { STALE_ITEM_LABEL, teamPortfolio } from './portfolios.js';

describe('eval portfolio fixture', () => {
  const { name, cards, total, nowMs } = teamPortfolio;
  const a = computeAggregates(cards, total, nowMs);

  it('has the known, uncapped aggregates the cases assert against', () => {
    expect(a.total).toBe(8);
    expect(a.capped).toBe(false);
    expect(a.jiraByStatus).toEqual([
      { status: 'Pronto para Delivery', count: 3 },
      { status: 'Done', count: 2 },
      { status: 'Blocked', count: 1 },
    ]);
    expect(a.zendeskByStatus).toEqual([
      { status: 'new', count: 1 },
      { status: 'open', count: 1 },
    ]);
    expect(a.byAssignee).toEqual([
      { assignee: 'sem responsável', count: 5 },
      { assignee: 'Gabriel Alves', count: 2 },
      { assignee: 'Carla Nunes', count: 1 },
    ]);
    expect(a.jiraCount).toBe(6);
    expect(a.zendeskCount).toBe(2);
  });

  it('has exactly one stale item, the one the cases cite', () => {
    expect(a.stale.map((c) => c.label)).toEqual([STALE_ITEM_LABEL]);
  });

  it('date guard knows the fixture dates and rejects others', () => {
    const rule = mustNotInventDateIn(renderPortfolio(name, cards, a, nowMs));
    expect(rule.check('Parado desde 20/08.')).toBe(true);
    expect(rule.check('O prazo é 03/11.')).toBe(false);
  });
});

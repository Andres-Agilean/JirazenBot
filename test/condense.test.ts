import { describe, expect, it } from 'vitest';
import { condenseChangelog, condenseDevelopment } from '@/fetch/condense.js';
import { fixture } from './helpers.js';

describe('condenseChangelog', () => {
  it('keeps only status and assignee items, ascending', () => {
    const issue = fixture('jira-issue') as { changelog: { histories: any[] } };
    const raw = issue.changelog.histories
      .map((h) => ({ at: h.created, by: h.author.displayName, items: h.items }))
      .sort((a, b) => a.at.localeCompare(b.at));
    const t = condenseChangelog(raw);
    expect(t).toEqual([
      { field: 'assignee', from: null, to: 'Otavio Fernandes', at: '2026-08-04T09:06:00.000-0300', by: 'Heitor Alves' },
      { field: 'status', from: 'Backlog', to: 'Em Andamento', at: '2026-08-04T09:07:00.000-0300', by: 'Automation for Jira' },
      { field: 'status', from: 'Em Andamento', to: 'Em Teste', at: '2026-08-10T14:59:00.000-0300', by: 'Automation for Jira' },
    ]);
  });
});

describe('condenseDevelopment', () => {
  it('summarizes the PR blob in pt-BR', () => {
    const issue = fixture('jira-issue') as { fields: Record<string, unknown> };
    expect(condenseDevelopment(issue.fields.customfield_10000)).toBe('1 pull request — MERGED (atualizado 2026-08-10)');
  });

  it('returns null for empty or unparsable values', () => {
    expect(condenseDevelopment('{}')).toBeNull();
    expect(condenseDevelopment(null)).toBeNull();
    expect(condenseDevelopment('garbage')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { buildResolver } from '@/bundle/load.js';
import { JiraClient } from '@/fetch/jira.js';
import { testConfig, makeFetch } from './helpers.js';

describe('buildResolver', () => {
  it('builds strategies in the configured order', async () => {
    const jira = new JiraClient(testConfig, makeFetch({}));
    const resolver = buildResolver(
      { ...testConfig, resolverOrder: ['jira_zendesk_id_field', 'zendesk_links'] },
      jira,
    );
    // The Resolver stores its strategies in priority order; the first must be the field strategy.
    expect((resolver as any).strategies.map((s: any) => s.name)).toEqual([
      'jira_zendesk_id_field',
      'zendesk_links',
    ]);
  });
});

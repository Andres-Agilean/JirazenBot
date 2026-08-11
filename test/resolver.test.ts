import { describe, expect, it } from 'vitest';
import { ZendeskLinksStrategy, JiraFieldStrategy, type ResolverStrategy } from '../src/resolve/strategies.js';
import { Resolver } from '../src/resolve/resolver.js';
import { JiraClient } from '../src/fetch/jira.js';
import { fixture, makeFetch, testConfig } from './helpers.js';

const issueRef = { issueId: '42395', issueKey: 'QZ-252' };

describe('ZendeskLinksStrategy', () => {
  it('resolves both directions through the links endpoint', async () => {
    const f = makeFetch({ '/api/v2/integrations/jira/00000000-0000-0000-0000-000000000000/links': fixture('links-single') });
    const s = new ZendeskLinksStrategy(testConfig, f);
    expect(await s.jiraToZendesk(issueRef)).toEqual(['16467']);
    expect(await s.zendeskToJira('16467')).toEqual([issueRef]);
  });

  it('surfaces multi-links as multiple hits', async () => {
    const f = makeFetch({ '/links': fixture('links-multi') });
    const s = new ZendeskLinksStrategy(testConfig, f);
    expect(await s.zendeskToJira('16467')).toHaveLength(2);
  });

  it('throws on 403 so the orchestrator can fall through', async () => {
    const f = makeFetch({ '/links': { status: 403 } });
    await expect(new ZendeskLinksStrategy(testConfig, f).zendeskToJira('16467')).rejects.toThrow(/403/);
  });

  it('asserts GET-only method', async () => {
    let seenMethod: string | undefined;
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      seenMethod = init?.method;
      return makeFetch({ '/links': fixture('links-single') })(input, init);
    }) as typeof fetch;
    await new ZendeskLinksStrategy(testConfig, spy).zendeskToJira('16467');
    expect(seenMethod === undefined || seenMethod === 'GET').toBe(true);
  });

  it('normalizes numeric ids from the links API to strings', async () => {
    const f = makeFetch({ '/links': fixture('links-numeric') });
    const s = new ZendeskLinksStrategy(testConfig, f);
    expect(await s.jiraToZendesk(issueRef)).toEqual(['16467']);
    expect(await s.zendeskToJira('16467')).toEqual([{ issueId: '42395', issueKey: 'QZ-252' }]);
  });
});

describe('JiraFieldStrategy', () => {
  const jira = new JiraClient(testConfig, makeFetch({
    '/rest/api/3/issue/42395/comment': fixture('jira-comments'),
    '/rest/api/3/issue/42395': fixture('jira-issue'),
    '/rest/api/3/search/jql': fixture('jql-search'),
  }));

  it('reads the Zendesk ID field for jira→zendesk', async () => {
    expect(await new JiraFieldStrategy(jira, testConfig).jiraToZendesk(issueRef)).toEqual(['16467']);
  });

  it('searches JQL for zendesk→jira', async () => {
    expect(await new JiraFieldStrategy(jira, testConfig).zendeskToJira('16467')).toEqual([issueRef]);
  });

  it('returns no ticket when the Zendesk ID field is empty or whitespace', async () => {
    const blank = { ...(fixture('jira-issue') as any), fields: { ...(fixture('jira-issue') as any).fields, customfield_10356: '   ' } };
    const jiraBlank = new JiraClient(testConfig, makeFetch({
      '/rest/api/3/issue/42395/comment': fixture('jira-comments'),
      '/rest/api/3/issue/42395': blank,
    }));
    expect(await new JiraFieldStrategy(jiraBlank, testConfig).jiraToZendesk(issueRef)).toEqual([]);
  });
});

describe('Resolver orchestration', () => {
  const failing: ResolverStrategy = {
    name: 'zendesk_links',
    jiraToZendesk: async () => { throw new Error('403'); },
    zendeskToJira: async () => { throw new Error('403'); },
  };
  const winning: ResolverStrategy = {
    name: 'jira_zendesk_id_field',
    jiraToZendesk: async () => ['16467'],
    zendeskToJira: async () => [issueRef],
  };
  const empty: ResolverStrategy = { ...winning, jiraToZendesk: async () => [], zendeskToJira: async () => [] };

  it('falls through failing strategies and records the winning via', async () => {
    const r = new Resolver([failing, winning]);
    expect(await r.zendeskToJira('16467')).toEqual({ hits: [issueRef], via: 'jira_zendesk_id_field' });
  });

  it('falls through empty results to the next strategy', async () => {
    const r = new Resolver([empty, winning]);
    expect(await r.jiraToZendesk(issueRef)).toEqual({ hits: ['16467'], via: 'jira_zendesk_id_field' });
  });

  it('returns null when nothing resolves', async () => {
    expect(await new Resolver([failing, empty]).zendeskToJira('16467')).toBeNull();
  });
});

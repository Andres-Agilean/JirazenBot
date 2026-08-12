import { describe, expect, it } from 'vitest';
import { JiraClient, JIRA_FIELD_LABELS } from '../src/fetch/jira.js';
import { NotFoundError } from '../src/fetch/errors.js';
import { fixture, makeFetch, testConfig } from './helpers.js';

const routes = {
  '/rest/api/3/issue/QZ-252/comment': fixture('jira-comments'),
  '/rest/api/3/issue/QZ-252': fixture('jira-issue'),
  '/rest/api/3/search/jql': fixture('jql-search'),
  '/rest/api/3/issue/QZ-999': { status: 404, body: { errorMessages: ['Issue does not exist'] } },
};

describe('JiraClient', () => {
  it('fetches an issue with whitelisted fields, comments and changelog', async () => {
    const jira = new JiraClient(testConfig, makeFetch(routes));
    const issue = await jira.getIssue('QZ-252');
    expect(issue.issueId).toBe('42395');
    expect(issue.issueKey).toBe('QZ-252');
    expect(issue.fields.summary).toContain('Aplicativo travando');
    expect(issue.fields.customfield_10356).toBe('16467');
    expect(Object.keys(issue.fields).every((k) => k in JIRA_FIELD_LABELS)).toBe(true);
    expect(issue.comments).toHaveLength(2);
    expect(issue.comments[0].author).toBe('Otavio Fernandes');
    expect(issue.changelog).toHaveLength(3);
    // ascending sort: the 09:06 assignee entry comes before the 09:07 status entry
    expect(issue.changelog[0].items[0].field).toBe('assignee');
  });

  it('sends Basic auth built from email:token and uses GET method', async () => {
    let seenAuth = '';
    let seenMethod: string | undefined = '';
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      seenMethod = init?.method;
      return makeFetch(routes)(input, init);
    }) as typeof fetch;
    await new JiraClient(testConfig, spy).getIssue('QZ-252');
    const decoded = Buffer.from(seenAuth.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('svc@example.com:fake-jira-token');
    expect(seenMethod === undefined || seenMethod === 'GET').toBe(true);
  });

  it('throws NotFoundError on 404', async () => {
    const jira = new JiraClient(testConfig, makeFetch(routes));
    await expect(jira.getIssue('QZ-999')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requests comments newest-first, returns them ascending, and flags omission when total exceeds the page', async () => {
    const overflowRoutes = {
      '/rest/api/3/issue/QZ-300/comment': fixture('jira-comments-overflow'),
      '/rest/api/3/issue/QZ-300': fixture('jira-issue'),
    };
    let seenUrl = '';
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/comment')) seenUrl = url;
      return makeFetch(overflowRoutes)(input, init);
    }) as typeof fetch;
    const issue = await new JiraClient(testConfig, spy).getIssue('QZ-300');
    expect(seenUrl).toContain('orderBy=-created');
    expect(issue.comments.map((c) => c.id)).toEqual(['1', '2', '3']); // ascending, newest last
    expect(issue.olderCommentsOmitted).toBe(true);
  });

  it('does not flag omission when the returned page covers all comments', async () => {
    const jira = new JiraClient(testConfig, makeFetch(routes));
    const issue = await jira.getIssue('QZ-252');
    expect(issue.olderCommentsOmitted).toBe(false);
  });

  it('searches issues by Zendesk id via JQL restricted to allowed projects', async () => {
    let seenUrl = '';
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      seenUrl = String(input);
      return makeFetch(routes)(input, init);
    }) as typeof fetch;
    const refs = await new JiraClient(testConfig, spy).searchByZendeskId('16467');
    expect(refs).toEqual([{ issueId: '42395', issueKey: 'QZ-252' }]);
    const jql = decodeURIComponent(seenUrl);
    expect(jql).toContain('cf[10356] ~ "16467"');
    expect(jql).toContain('project in (AGL,AI,MDO,QZ,SC)');
  });
});

import { describe, expect, it } from 'vitest';
import { JiraClient, JIRA_FIELD_LABELS } from '@/fetch/jira.js';
import { NotFoundError } from '@/fetch/errors.js';
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

  it('returns comments ascending even when the server ignores orderBy=-created and returns them ascending already, and still flags overflow', async () => {
    // Both existing Jira comment fixtures are stored strictly descending, so a blind .reverse()
    // and the client-side sort produce identical output there -- neither discriminates the fix.
    // This fixture is stored ascending (as if the server ignored orderBy=-created), so only the
    // client-side sort-by-`created` keeps the result ascending; a .reverse() would flip it to
    // descending and fail the assertion below.
    const ascendingRoutes = {
      '/rest/api/3/issue/QZ-301/comment': fixture('jira-comments-ascending-overflow'),
      '/rest/api/3/issue/QZ-301': fixture('jira-issue'),
    };
    const issue = await new JiraClient(testConfig, makeFetch(ascendingRoutes)).getIssue('QZ-301');
    expect(issue.comments.map((c) => c.id)).toEqual(['1', '2', '3']); // ascending, newest last
    expect(issue.olderCommentsOmitted).toBe(true);
  });

  it('does not flag omission when the returned page covers all comments', async () => {
    const jira = new JiraClient(testConfig, makeFetch(routes));
    const issue = await jira.getIssue('QZ-252');
    expect(issue.olderCommentsOmitted).toBe(false);
  });

  it('always requests and retains the configured Zendesk-id field, even one absent from JIRA_FIELD_LABELS', async () => {
    // customfield_99999 is deliberately NOT a key in JIRA_FIELD_LABELS (jira-issue.json calls it
    // "ruído" precisely because it's normally dropped as noise -- see render.test.ts). If an
    // operator ever points JIRA_ZENDESK_ID_FIELD at a field this static table doesn't know about
    // (e.g. a different Jira Cloud tenant), getIssue must still fetch and keep it, or
    // JiraFieldStrategy.jiraToZendesk would look up `undefined` and silently stop resolving.
    const customCfg = { ...testConfig, zendeskIdField: 'customfield_99999' };
    let seenIssueUrl = '';
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/api/3/issue/QZ-252?')) seenIssueUrl = url;
      return makeFetch(routes)(input, init);
    }) as typeof fetch;
    const issue = await new JiraClient(customCfg, spy).getIssue('QZ-252');
    expect(decodeURIComponent(seenIssueUrl)).toContain('customfield_99999');
    expect(issue.fields.customfield_99999).toBe('ruído');
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

  it('searchActiveByText builds the JQL with sanitized text and maps results', async () => {
    const calls: string[] = [];
    const f: typeof fetch = (async (url: any) => { calls.push(decodeURIComponent(String(url)));
      return new Response(JSON.stringify({ issues: [{ id: '1', key: 'AGL-900',
        fields: { summary: 'Relatório', status: { name: 'Em Teste' }, updated: '2026-09-28T10:00:00.000-0300' } }] }), { status: 200 }); }) as any;
    const result = await new JiraClient(testConfig, f).searchActiveByText('obra "x" OR project=SEC');
    expect(calls[0]).toContain('text ~ "obra x OR project=SEC"');   // quotes stripped, value stays inside ONE string
    expect(calls[0]).toContain('resolution is EMPTY');
    expect(result).toEqual([{ issueKey: 'AGL-900', summary: 'Relatório', status: 'Em Teste', updatedAt: '2026-09-28T10:00:00.000-0300' }]);
  });

  it('searchByZendeskIds returns [] without a request for empty input', async () => {
    const f: typeof fetch = (async () => { throw new Error('must not be called'); }) as any;
    expect(await new JiraClient(testConfig, f).searchByZendeskIds([])).toEqual([]);
  });

  it('searchByZendeskIds ORs the ids into one query and carries the zendesk id back', async () => {
    const calls: string[] = [];
    const f: typeof fetch = (async (url: any) => { calls.push(decodeURIComponent(String(url)));
      return new Response(JSON.stringify({ issues: [{ id: '1', key: 'QZ-252',
        fields: { summary: 'Crash', status: { name: 'Done' }, updated: '2026-09-01T10:00:00.000-0300', customfield_10356: '16467' } }] }), { status: 200 }); }) as any;
    const result = await new JiraClient(testConfig, f).searchByZendeskIds(['16467', '16468']);
    expect(calls[0]).toContain('cf[10356] ~ "16467" OR cf[10356] ~ "16468"');
    expect(result[0]).toMatchObject({ issueKey: 'QZ-252', zendeskId: '16467' });
  });
});

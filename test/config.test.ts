import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { fixture, makeFetch } from './helpers.js';

const validEnv = {
  ATLASSIAN_SITE_URL: 'https://your-tenant.atlassian.net/',
  ATLASSIAN_EMAIL: 'svc@example.com',
  ATLASSIAN_API_TOKEN: 'jt',
  ATLASSIAN_ALLOWED_PROJECTS: 'AGL, AI,MDO,QZ,SC',
  ZENDESK_SUBDOMAIN: 'your-subdomain',
  ZENDESK_EMAIL: 'svc@example.com',
  ZENDESK_API_TOKEN: 'zt',
  ZENDESK_JIRA_EXTERNAL_ID: '00000000-0000-0000-0000-000000000000',
};

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.siteUrl).toBe('https://your-tenant.atlassian.net'); // trailing slash stripped
    expect(cfg.allowedProjects).toEqual(['AGL', 'AI', 'MDO', 'QZ', 'SC']); // trimmed
    expect(cfg.resolverOrder).toEqual(['zendesk_links', 'jira_zendesk_id_field']);
    expect(cfg.zendeskIdField).toBe('customfield_10356');
    expect(cfg.bundleTokenBudget).toBe(25000);
  });

  it('throws when a required variable is missing', () => {
    const { ATLASSIAN_API_TOKEN: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(/ATLASSIAN_API_TOKEN/);
  });

  it('rejects an unknown resolver strategy name', () => {
    expect(() => loadConfig({ ...validEnv, RESOLVER_ORDER: 'zendesk_links,bogus' })).toThrow(/bogus/);
  });
});

describe('test helpers', () => {
  it('loads fixtures and serves routed fetch responses', async () => {
    const issue = fixture('jira-issue') as { key: string };
    expect(issue.key).toBe('QZ-252');
    const f = makeFetch({ '/rest/api/3/issue/': issue, '/nope': { status: 404 } });
    const res = await f('https://x.test/rest/api/3/issue/QZ-252');
    expect(((await res.json()) as { key: string }).key).toBe('QZ-252');
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig, requireAnthropicKey, MISSING_ANTHROPIC_KEY_MESSAGE } from '@/config.js';
import { fixture, makeFetch } from './helpers.js';

const validEnv = {
  ATLASSIAN_SITE_URL: 'https://your-tenant.atlassian.net/',
  ATLASSIAN_CLOUD_ID: '00000000-0000-0000-0000-000000000000',
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
    const cfg = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(cfg.jiraApiBaseUrl).toBe('https://api.atlassian.com/ex/jira/00000000-0000-0000-0000-000000000000');
    expect(cfg.siteUrl).toBe('https://your-tenant.atlassian.net'); // trailing slash stripped, display-only
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

  it('rejects a JIRA_ZENDESK_ID_FIELD that is not a customfield_<n> id', () => {
    // searchByZendeskId (src/fetch/jira.ts) strips "customfield_" off this value to build the
    // JQL cf[<n>] filter; a value outside that shape must fail loudly here, in pt-BR, rather than
    // silently producing a bogus filter or an undefined field lookup downstream.
    expect(() => loadConfig({ ...validEnv, JIRA_ZENDESK_ID_FIELD: 'zendesk_ticket_id' })).toThrow(
      /JIRA_ZENDESK_ID_FIELD/,
    );
  });

  it('accepts a JIRA_ZENDESK_ID_FIELD that points at a different custom field id', () => {
    // Custom field ids are site-specific (addendum), so a valid, differently-numbered field must
    // still be accepted -- only the shape is being validated here, not the specific number.
    const cfg = loadConfig({ ...validEnv, JIRA_ZENDESK_ID_FIELD: 'customfield_99999' });
    expect(cfg.zendeskIdField).toBe('customfield_99999');
  });

  it('loads config without a Claude API key (regression: bundle path does not need Claude)', () => {
    // The bundle path (card.ts) is read-only Jira + Zendesk fetches, no Claude calls.
    // Confirm that config can load cleanly without ANTHROPIC_API_KEY present.
    expect(() => loadConfig(validEnv)).not.toThrow();
  });
});

describe('loadConfig — Claude settings', () => {
  it('parses the Claude settings and applies defaults', () => {
    const cfg = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(cfg.anthropicApiKey).toBe('sk-ant-test');
    expect(cfg.claudeModel).toBe('claude-sonnet-5');
    expect(cfg.claudeMaxTokens).toBe(2048);
  });

  it('allows overriding the model and max tokens', () => {
    const cfg = loadConfig({
      ...validEnv,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      CLAUDE_MODEL: 'claude-opus-5',
      CLAUDE_MAX_TOKENS: '4096',
    });
    expect(cfg.claudeModel).toBe('claude-opus-5');
    expect(cfg.claudeMaxTokens).toBe(4096);
  });

  it('defaults the Anthropic key to an empty string when not provided', () => {
    // The bundle path (card.ts) does not need Claude, so the API key is optional.
    const cfg = loadConfig(validEnv);
    expect(cfg.anthropicApiKey).toBe('');
  });

  it('requireAnthropicKey returns the key when set', () => {
    const cfg = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: 'sk-ant-valid-key' });
    expect(requireAnthropicKey(cfg)).toBe('sk-ant-valid-key');
  });

  it('requireAnthropicKey throws when the key is empty', () => {
    const cfg = loadConfig(validEnv);
    expect(() => requireAnthropicKey(cfg)).toThrow(MISSING_ANTHROPIC_KEY_MESSAGE);
  });

  it('requireAnthropicKey throws when the key is only whitespace (stray .env space)', () => {
    const cfg = loadConfig({ ...validEnv, ANTHROPIC_API_KEY: '   ' });
    expect(() => requireAnthropicKey(cfg)).toThrow(MISSING_ANTHROPIC_KEY_MESSAGE);
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

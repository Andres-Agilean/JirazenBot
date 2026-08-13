import { describe, expect, it } from 'vitest';
import { formatFooter, jiraLink, withFooter, zendeskLink } from '@/teams/reply.js';
import { testConfig } from './helpers.js';
import type { Binding } from '@/teams/bindings.js';
import type { CardBundle } from '@/bundle/types.js';

function makeBinding(jira = true, zendesk = true): Binding {
  const bundle = {
    fetchedAt: '2026-08-13T17:32:00.000Z', // 14:32 in America/Sao_Paulo (UTC-3)
    surface: 'dm',
    ...(jira
      ? {
          jira: { issueId: '42395', issueKey: 'QZ-252', fields: {}, comments: [], statusHistory: [] },
        }
      : {}),
    ...(zendesk
      ? {
          zendesk: {
            ticketId: '16467', subject: 's', status: 'open', priority: null,
            createdAt: '', updatedAt: '', comments: [], internalNotesOmitted: false,
          },
        }
      : {}),
    resolution: { via: 'jira_zendesk_id_field', ambiguous: false },
    truncationNotes: [],
  } as CardBundle;
  return {
    ref: { system: 'jira', issueKey: 'QZ-252', explicit: true },
    bundle, bundleFetchedAt: 0, history: [], boundAt: 0,
  };
}

describe('links', () => {
  it('builds a Jira browse link from the display site URL, not the API gateway', () => {
    expect(jiraLink('QZ-252', testConfig)).toBe(
      'https://your-tenant.atlassian.net/browse/QZ-252',
    );
  });

  it('builds a Zendesk agent link from the subdomain', () => {
    expect(zendeskLink('16467', testConfig)).toBe(
      'https://your-subdomain.zendesk.com/agent/tickets/16467',
    );
  });
});

describe('formatFooter', () => {
  it('names both sides and the collection time in Brazil local time', () => {
    const footer = formatFooter(makeBinding(), testConfig);
    expect(footer).toContain('[QZ-252](https://your-tenant.atlassian.net/browse/QZ-252)');
    expect(footer).toContain('[chamado 16467](https://your-subdomain.zendesk.com/agent/tickets/16467)');
    expect(footer).toContain('14:32'); // not 17:32 — users are in Brazil
  });

  it('omits the Zendesk half when the card is single-sided (Jira only)', () => {
    const footer = formatFooter(makeBinding(true, false), testConfig);
    expect(footer).toContain('QZ-252');
    expect(footer).not.toContain('chamado');
    expect(footer).not.toContain(' ↔ ');
  });

  it('omits the Jira half when the card is single-sided (Zendesk only)', () => {
    const footer = formatFooter(makeBinding(false, true), testConfig);
    expect(footer).toContain('[chamado 16467](https://your-subdomain.zendesk.com/agent/tickets/16467)');
    expect(footer).not.toContain('QZ-252');
    expect(footer).not.toContain(' ↔ ');
  });
});

describe('withFooter', () => {
  it('appends the footer below the answer, leaving the answer untouched', () => {
    const out = withFooter('O status é Em Teste.', makeBinding(), testConfig);
    expect(out.startsWith('O status é Em Teste.')).toBe(true);
    expect(out).toContain('coletado às 14:32');
  });
});

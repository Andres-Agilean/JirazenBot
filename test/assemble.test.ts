import { describe, expect, it } from 'vitest';
import { assembleBundle, type AssembleDeps } from '../src/bundle/assemble.js';
import { JiraClient } from '../src/fetch/jira.js';
import { ZendeskClient } from '../src/fetch/zendesk.js';
import { Resolver } from '../src/resolve/resolver.js';
import { ZendeskLinksStrategy } from '../src/resolve/strategies.js';
import { fixture, makeFetch, testConfig } from './helpers.js';

const happyRoutes = {
  '/rest/api/3/issue/QZ-252/comment': fixture('jira-comments'),
  '/rest/api/3/issue/QZ-252': fixture('jira-issue'),
  '/rest/api/3/issue/42395/comment': fixture('jira-comments'),
  '/rest/api/3/issue/42395': fixture('jira-issue'),
  '/rest/api/3/search/jql': fixture('jql-search'),
  '/api/v2/tickets/16467/comments': fixture('zendesk-comments'),
  '/api/v2/tickets/16467.json': fixture('zendesk-ticket'),
  '/links': fixture('links-single'),
};

function deps(routes: Record<string, unknown>): AssembleDeps {
  const f = makeFetch(routes);
  return {
    jira: new JiraClient(testConfig, f),
    zendesk: new ZendeskClient(testConfig, f),
    resolver: new Resolver([new ZendeskLinksStrategy(testConfig, f)]),
  };
}

const now = () => new Date('2026-08-10T18:00:00Z');

describe('assembleBundle', () => {
  it('assembles both sides from a Jira ref', async () => {
    const r = await assembleBundle({ system: 'jira', issueKey: 'QZ-252', explicit: true }, deps(happyRoutes), 'dm', now);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.bundle.jira?.issueKey).toBe('QZ-252');
    expect(r.bundle.zendesk?.ticketId).toBe('16467');
    expect(r.bundle.resolution).toEqual({ via: 'zendesk_links', ambiguous: false });
    expect(r.bundle.fetchedAt).toBe('2026-08-10T18:00:00.000Z');
    expect(r.bundle.jira?.statusHistory.filter((t) => t.field === 'status')).toHaveLength(2);
  });

  it('assembles both sides from a Zendesk ref', async () => {
    const r = await assembleBundle({ system: 'zendesk', ticketId: '16467', explicit: true }, deps(happyRoutes), 'dm', now);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.bundle.zendesk?.comments).toHaveLength(3);
    expect(r.bundle.jira?.issueKey).toBe('QZ-252');
  });

  it('suppresses internal notes on multiparty surface', async () => {
    const r = await assembleBundle({ system: 'zendesk', ticketId: '16467', explicit: true }, deps(happyRoutes), 'multiparty', now);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.bundle.zendesk?.comments).toHaveLength(2);
    expect(r.bundle.zendesk?.comments.every((c) => c.isPublic)).toBe(true);
    expect(r.bundle.zendesk?.internalNotesOmitted).toBe(true);
  });

  it('returns ambiguous when the counterpart is multi-linked', async () => {
    const r = await assembleBundle({ system: 'zendesk', ticketId: '16467', explicit: true }, deps({ ...happyRoutes, '/links': fixture('links-multi') }), 'dm', now);
    expect(r).toEqual({ status: 'ambiguous', side: 'jira', candidates: ['QZ-252', 'AGL-1500'] });
  });

  it('returns a single-sided bundle when no counterpart exists', async () => {
    const r = await assembleBundle({ system: 'zendesk', ticketId: '16467', explicit: true }, deps({ ...happyRoutes, '/links': { count: 0, links: [] } }), 'dm', now);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.bundle.jira).toBeUndefined();
    expect(r.bundle.resolution.via).toBe('direct_only');
  });

  it('discloses omitted older Jira comments as a truncation note', async () => {
    const r = await assembleBundle(
      { system: 'jira', issueKey: 'QZ-252', explicit: true },
      deps({ ...happyRoutes, '/rest/api/3/issue/QZ-252/comment': fixture('jira-comments-overflow') }),
      'dm',
      now,
    );
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.bundle.truncationNotes).toContain('comentários mais antigos do Jira não foram carregados (limite de 100)');
  });

  it('discloses omitted older Zendesk comments as a truncation note', async () => {
    const r = await assembleBundle(
      { system: 'zendesk', ticketId: '16467', explicit: true },
      deps({ ...happyRoutes, '/api/v2/tickets/16467/comments': fixture('zendesk-comments-overflow') }),
      'dm',
      now,
    );
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.bundle.truncationNotes).toContain('comentários mais antigos do Zendesk não foram carregados (limite de 100)');
  });

  it('returns not_found for a missing ticket', async () => {
    const r = await assembleBundle({ system: 'zendesk', ticketId: '99999', explicit: true }, deps({ '/api/v2/tickets/99999': { status: 404 } }), 'dm', now);
    expect(r.status).toBe('not_found');
  });

  it('degrades to a single-sided bundle with a note when the resolved counterpart 404s', async () => {
    const r = await assembleBundle(
      { system: 'zendesk', ticketId: '16467', explicit: true },
      deps({ ...happyRoutes, '/rest/api/3/issue/QZ-252': { status: 404 }, '/rest/api/3/issue/42395': { status: 404 } }),
      'dm',
      now,
    );
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.bundle.jira).toBeUndefined();
    expect(r.bundle.zendesk?.ticketId).toBe('16467');
    expect(r.bundle.resolution.via).toBe('zendesk_links');
    expect(r.bundle.truncationNotes).toContain('contraparte Jira QZ-252 foi encontrada mas não pôde ser carregada');
  });

  it('rethrows a non-NotFoundError on the referenced side instead of reporting not_found', async () => {
    const boom: typeof fetch = async () => {
      throw new Error('ECONNRESET');
    };
    const failingDeps: AssembleDeps = {
      jira: new JiraClient(testConfig, boom),
      zendesk: new ZendeskClient(testConfig, boom),
      resolver: new Resolver([new ZendeskLinksStrategy(testConfig, boom)]),
    };
    await expect(
      assembleBundle({ system: 'zendesk', ticketId: '16467', explicit: true }, failingDeps, 'dm', now),
    ).rejects.toThrow('ECONNRESET');
  });
});

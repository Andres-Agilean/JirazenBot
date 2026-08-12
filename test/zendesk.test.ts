import { describe, expect, it } from 'vitest';
import { ZendeskClient } from '../src/fetch/zendesk.js';
import { NotFoundError } from '../src/fetch/jira.js';
import { fixture, makeFetch, testConfig } from './helpers.js';

const routes = {
  '/api/v2/tickets/16467/comments': fixture('zendesk-comments'),
  '/api/v2/tickets/16467.json': fixture('zendesk-ticket'),
  '/api/v2/tickets/99999': { status: 404, body: { error: 'RecordNotFound' } },
};

describe('ZendeskClient', () => {
  it('fetches ticket with comments, resolving author names and public flags', async () => {
    const zd = new ZendeskClient(testConfig, makeFetch(routes));
    const t = await zd.getTicket('16467');
    expect(t.ticketId).toBe('16467');
    expect(t.subject).toContain('Aplicativo travando');
    expect(t.status).toBe('open');
    expect(t.comments).toHaveLength(3);
    expect(t.comments[0]).toEqual({ id: 901, author: 'Bruna Rocha', isPublic: true, createdAt: '2026-08-03T18:00:00Z', body: 'Ao tirar uma foto o aplicativo fecha' });
    expect(t.comments[1].isPublic).toBe(false);
  });

  it('authenticates with {email}/token:{token}', async () => {
    let seenAuth = '';
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return makeFetch(routes)(input, init);
    }) as typeof fetch;
    await new ZendeskClient(testConfig, spy).getTicket('16467');
    const decoded = Buffer.from(seenAuth.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('svc@example.com/token:fake-zendesk-token');
  });

  it('asserts GET-only method', async () => {
    let seenMethod = '';
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      seenMethod = init?.method ?? 'GET';
      return makeFetch(routes)(input, init);
    }) as typeof fetch;
    await new ZendeskClient(testConfig, spy).getTicket('16467');
    expect(seenMethod).toBe('GET');
  });

  it('requests comments newest-first, returns them ascending, and flags omission when has_more is true', async () => {
    const overflowRoutes = { '/api/v2/tickets/20000/comments': fixture('zendesk-comments-overflow'), '/api/v2/tickets/20000.json': fixture('zendesk-ticket') };
    let seenUrl = '';
    const spy: typeof fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/comments')) seenUrl = url;
      return makeFetch(overflowRoutes)(input, init);
    }) as typeof fetch;
    const t = await new ZendeskClient(testConfig, spy).getTicket('20000');
    expect(seenUrl).toContain('sort=-created_at');
    expect(t.comments.map((c) => c.id)).toEqual([1, 2, 3]); // ascending, newest last
    expect(t.olderCommentsOmitted).toBe(true);
  });

  it('does not flag omission when has_more is false', async () => {
    const zd = new ZendeskClient(testConfig, makeFetch(routes));
    const t = await zd.getTicket('16467');
    expect(t.olderCommentsOmitted).toBe(false);
  });

  it('throws NotFoundError for deleted/unknown tickets', async () => {
    const zd = new ZendeskClient(testConfig, makeFetch(routes));
    await expect(zd.getTicket('99999')).rejects.toBeInstanceOf(NotFoundError);
  });
});

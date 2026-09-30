import { describe, expect, it } from 'vitest';
import { ZendeskClient, ORG_RESULT_CAP, CARD_FETCH_CAP } from '@/fetch/zendesk.js';
import { NotFoundError } from '@/fetch/errors.js';
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

  it('handles a degraded offset-pagination response (ascending comments, next_page, no meta) without misordering or hiding overflow', async () => {
    // If Zendesk ever ignores sort=-created_at, or the request falls back to legacy
    // offset pagination, the response carries next_page/count and no meta at all -- and the
    // comments may already be ascending. A blind .reverse() would flip that into descending
    // order, and meta?.has_more would be undefined so the overflow would go undisclosed.
    const offsetRoutes = {
      '/api/v2/tickets/20001/comments': fixture('zendesk-comments-offset-overflow'),
      '/api/v2/tickets/20001.json': fixture('zendesk-ticket'),
    };
    const t = await new ZendeskClient(testConfig, makeFetch(offsetRoutes)).getTicket('20001');
    expect(t.comments.map((c) => c.id)).toEqual([1, 2, 3]); // still ascending
    expect(t.olderCommentsOmitted).toBe(true);
  });

  it('does not flag omission on the last cursor page even though links.next is always present', async () => {
    // Zendesk's cursor pagination returns a links.next URL on every page, including the last
    // one -- meta.has_more is the only reliable signal once meta is present. Mirrors the live
    // response observed for ticket 16467 (17 comments, meta.has_more: false, links.next set).
    const cursorRoutes = {
      '/api/v2/tickets/20002/comments': fixture('zendesk-comments-cursor-last-page'),
      '/api/v2/tickets/20002.json': fixture('zendesk-ticket'),
    };
    const t = await new ZendeskClient(testConfig, makeFetch(cursorRoutes)).getTicket('20002');
    expect(t.olderCommentsOmitted).toBe(false);
  });

  it('flags omission when meta.has_more is true, regardless of links', async () => {
    const overflowRoutes = { '/api/v2/tickets/20000/comments': fixture('zendesk-comments-overflow'), '/api/v2/tickets/20000.json': fixture('zendesk-ticket') };
    const t = await new ZendeskClient(testConfig, makeFetch(overflowRoutes)).getTicket('20000');
    expect(t.olderCommentsOmitted).toBe(true);
  });

  it('flags a comment mirrored from Jira with the referenced issue key and author', async () => {
    const mirrorRoutes = {
      '/api/v2/tickets/20003/comments': {
        comments: [
          { id: 1, author_id: 1, public: false, created_at: '2026-08-10T20:00:00Z', body: '[Jira] QZ-252 — André Marques:\n\naprovado' },
          { id: 2, author_id: 1, public: true, created_at: '2026-08-10T21:00:00Z', body: 'comentário normal, sem prefixo' },
        ],
        users: [{ id: 1, name: 'Integração Jira' }],
        meta: { has_more: false },
      },
      '/api/v2/tickets/20003.json': fixture('zendesk-ticket'),
    };
    const t = await new ZendeskClient(testConfig, makeFetch(mirrorRoutes)).getTicket('20003');
    expect(t.comments[0].mirrorOf).toEqual({ issueKey: 'QZ-252', author: 'André Marques' });
    expect(t.comments[1].mirrorOf).toBeUndefined();
  });

  it('throws NotFoundError for deleted/unknown tickets', async () => {
    const zd = new ZendeskClient(testConfig, makeFetch(routes));
    await expect(zd.getTicket('99999')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('searchOrganizations', () => {
    it('returns id+name capped at ORG_RESULT_CAP', async () => {
      const orgs = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Org ${i + 1}`, extra: 'x' }));
      const f = makeFetch({ '/api/v2/organizations/autocomplete.json': { organizations: orgs } });
      const client = new ZendeskClient(testConfig, f);
      const result = await client.searchOrganizations('org');
      expect(result).toHaveLength(ORG_RESULT_CAP);
      expect(result[0]).toEqual({ id: 1, name: 'Org 1' });
    });

    it('URL-encodes the name', async () => {
      const calls: string[] = [];
      const f: typeof fetch = (async (url: any) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
      }) as any;
      await new ZendeskClient(testConfig, f).searchOrganizations('norte & construtora');
      expect(calls[0]).toContain('name=norte%20%26%20construtora');
    });
  });

  describe('openTicketsForOrganization', () => {
    it('maps search results to summaries, capped', async () => {
      const results = Array.from({ length: 30 }, (_, i) => ({
        id: 1000 + i,
        subject: `Ticket ${i}`,
        status: 'open',
        updated_at: '2026-09-29T10:00:00Z',
        result_type: 'ticket',
      }));
      const f = makeFetch({ '/api/v2/search.json': { results } });
      const tickets = await new ZendeskClient(testConfig, f).openTicketsForOrganization(42);
      expect(tickets).toHaveLength(CARD_FETCH_CAP);
      expect(tickets[0]).toEqual({ ticketId: '1000', subject: 'Ticket 0', status: 'open', updatedAt: '2026-09-29T10:00:00Z' });
    });

    it('propagates HTTP errors as the client\'s typed error (existing httpStatusError path)', async () => {
      const f = makeFetch({ '/api/v2/search.json': { status: 500 } });
      await expect(new ZendeskClient(testConfig, f).openTicketsForOrganization(42)).rejects.toThrow(/Zendesk 500/);
    });

    it('pins the query string with all required parameters', async () => {
      const calls: string[] = [];
      const f: typeof fetch = (async (url: any) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }) as any;
      await new ZendeskClient(testConfig, f).openTicketsForOrganization(42);
      const url = calls[0];
      expect(url).toContain('query=type%3Aticket%20organization_id%3A42%20status%3Csolved');
      expect(url).toContain('sort_by=updated_at');
      expect(url).toContain('sort_order=desc');
      expect(url).toContain(`per_page=${CARD_FETCH_CAP}`);
    });
  });
});

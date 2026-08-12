import type { Config } from '../config.js';
import { NotFoundError } from './jira.js';

// Zendesk comments API page size. Kept as a named constant rather than a repeated literal.
export const COMMENT_PAGE_SIZE = 100;

export interface ZendeskComment { id: number; author: string; isPublic: boolean; createdAt: string; body: string }
export interface ZendeskTicket {
  ticketId: string;
  subject: string;
  status: string;
  priority: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  comments: ZendeskComment[];
  olderCommentsOmitted?: boolean;
}

export class ZendeskClient {
  constructor(private cfg: Config, private fetchFn: typeof fetch = fetch) {}

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.cfg.zendeskEmail}/token:${this.cfg.zendeskToken}`).toString('base64');
    return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchFn(`https://${this.cfg.zendeskSubdomain}.zendesk.com${path}`, { headers: this.headers() });
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new Error(`Zendesk ${res.status} em ${path}`);
    return res.json();
  }

  async getTicket(ticketId: string): Promise<ZendeskTicket> {
    const t = (await this.get(`/api/v2/tickets/${ticketId}.json`)) as {
      ticket: { id: number; subject: string; status: string; priority: string | null; tags: string[]; created_at: string; updated_at: string };
    };
    // sort=-created_at (newest first): this is a Q&A bot whose most common question is "what's
    // the latest?", so when a ticket has more than 100 comments we must keep the newest 100, not
    // the oldest. We do NOT trust that the server honored the sort, or even that it returned the
    // modern cursor-paginated shape at all -- a degraded response could come back offset-paginated
    // (next_page/count, no meta) with comments already ascending. So we sort client-side by
    // created_at instead of blindly reversing, and check every overflow signal either shape can
    // carry (meta.has_more for cursor pagination; links.next or next_page for offset pagination).
    const c = (await this.get(`/api/v2/tickets/${ticketId}/comments.json?include=users&page[size]=${COMMENT_PAGE_SIZE}&sort=-created_at`)) as {
      comments: { id: number; author_id: number; public: boolean; created_at: string; body: string }[];
      users?: { id: number; name: string }[];
      meta?: { has_more?: boolean };
      links?: { next?: string | null };
      next_page?: string | null;
    };
    const names = new Map((c.users ?? []).map((u) => [u.id, u.name]));
    return {
      ticketId: String(t.ticket.id),
      subject: t.ticket.subject,
      status: t.ticket.status,
      priority: t.ticket.priority,
      tags: t.ticket.tags,
      createdAt: t.ticket.created_at,
      updatedAt: t.ticket.updated_at,
      comments: [...c.comments]
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((x) => ({
          id: x.id,
          author: names.get(x.author_id) ?? `usuário ${x.author_id}`,
          isPublic: x.public,
          createdAt: x.created_at,
          body: x.body,
        })),
      olderCommentsOmitted: c.meta?.has_more === true || c.links?.next != null || c.next_page != null,
    };
  }
}

import type { Config } from '../config.js';
import { NotFoundError } from './jira.js';

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
    const c = (await this.get(`/api/v2/tickets/${ticketId}/comments.json?include=users&page[size]=100`)) as {
      comments: { id: number; author_id: number; public: boolean; created_at: string; body: string }[];
      users?: { id: number; name: string }[];
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
      comments: c.comments.map((x) => ({
        id: x.id,
        author: names.get(x.author_id) ?? `usuário ${x.author_id}`,
        isPublic: x.public,
        createdAt: x.created_at,
        body: x.body,
      })),
    };
  }
}

import type { JiraIssueRef, ResolverVia } from './types.js';
import type { ResolverStrategy } from './strategies.js';

export type LinkLookup<T> = { hits: T[]; via: ResolverVia } | null;

export class Resolver {
  constructor(private strategies: ResolverStrategy[]) {}

  private async tryAll<T>(run: (s: ResolverStrategy) => Promise<T[]>): Promise<LinkLookup<T>> {
    for (const s of this.strategies) {
      try {
        const hits = await run(s);
        if (hits.length > 0) return { hits, via: s.name };
      } catch {
        // estratégia indisponível (ex.: 403) — tenta a próxima
      }
    }
    return null;
  }

  jiraToZendesk(issue: JiraIssueRef): Promise<LinkLookup<string>> {
    return this.tryAll((s) => s.jiraToZendesk(issue));
  }

  zendeskToJira(ticketId: string): Promise<LinkLookup<JiraIssueRef>> {
    return this.tryAll((s) => s.zendeskToJira(ticketId));
  }
}

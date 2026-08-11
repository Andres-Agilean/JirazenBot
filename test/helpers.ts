import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));

export const testConfig: Config = {
  siteUrl: 'https://your-tenant.atlassian.net',
  atlassianEmail: 'svc@example.com',
  atlassianToken: 'fake-jira-token',
  allowedProjects: ['AGL', 'AI', 'MDO', 'QZ', 'SC'],
  zendeskSubdomain: 'your-subdomain',
  zendeskEmail: 'svc@example.com',
  zendeskToken: 'fake-zendesk-token',
  zendeskJiraExternalId: '00000000-0000-0000-0000-000000000000',
  resolverOrder: ['zendesk_links', 'jira_zendesk_id_field'],
  zendeskIdField: 'customfield_10356',
  bundleTokenBudget: 25000,
};

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

type Route = unknown | { status: number; body?: unknown };

export function makeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [needle, route] of Object.entries(routes)) {
      if (url.includes(needle)) {
        const r = route as { status?: number; body?: unknown };
        const isTyped = r !== null && typeof r === 'object' && 'status' in (r as object);
        const status = isTyped ? (r.status as number) : 200;
        const body = isTyped ? r.body : route;
        return new Response(body === undefined ? '' : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`makeFetch: nenhuma rota para ${url}`);
  }) as typeof fetch;
}

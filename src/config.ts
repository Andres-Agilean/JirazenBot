import { z } from 'zod';

export type ResolverVia = 'zendesk_links' | 'jira_zendesk_id_field';
const VIA_VALUES: ResolverVia[] = ['zendesk_links', 'jira_zendesk_id_field'];

// Also assembleBundle's default `budgetTokens` (src/bundle/assemble.ts) -- named once here so
// the two spots that need "the default token budget" can't drift apart.
export const DEFAULT_BUNDLE_TOKEN_BUDGET = 25000;

const EnvSchema = z.object({
  ATLASSIAN_SITE_URL: z.string().url(),
  ATLASSIAN_EMAIL: z.string().min(1),
  ATLASSIAN_API_TOKEN: z.string().min(1),
  ATLASSIAN_ALLOWED_PROJECTS: z.string().min(1),
  ZENDESK_SUBDOMAIN: z.string().min(1),
  ZENDESK_EMAIL: z.string().min(1),
  ZENDESK_API_TOKEN: z.string().min(1),
  ZENDESK_JIRA_EXTERNAL_ID: z.string().min(1),
  RESOLVER_ORDER: z.string().default('zendesk_links,jira_zendesk_id_field'),
  JIRA_ZENDESK_ID_FIELD: z.string().default('customfield_10356'),
  BUNDLE_TOKEN_BUDGET: z.coerce.number().int().positive().default(DEFAULT_BUNDLE_TOKEN_BUDGET),
});

export interface Config {
  siteUrl: string;
  atlassianEmail: string;
  atlassianToken: string;
  allowedProjects: string[];
  zendeskSubdomain: string;
  zendeskEmail: string;
  zendeskToken: string;
  zendeskJiraExternalId: string;
  resolverOrder: ResolverVia[];
  zendeskIdField: string;
  bundleTokenBudget: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  const resolverOrder = e.RESOLVER_ORDER.split(',').map((s) => s.trim());
  for (const via of resolverOrder) {
    if (!VIA_VALUES.includes(via as ResolverVia)) {
      throw new Error(`RESOLVER_ORDER contém estratégia desconhecida: ${via}`);
    }
  }
  return {
    siteUrl: e.ATLASSIAN_SITE_URL.replace(/\/+$/, ''),
    atlassianEmail: e.ATLASSIAN_EMAIL,
    atlassianToken: e.ATLASSIAN_API_TOKEN,
    allowedProjects: e.ATLASSIAN_ALLOWED_PROJECTS.split(',').map((s) => s.trim()).filter(Boolean),
    zendeskSubdomain: e.ZENDESK_SUBDOMAIN,
    zendeskEmail: e.ZENDESK_EMAIL,
    zendeskToken: e.ZENDESK_API_TOKEN,
    zendeskJiraExternalId: e.ZENDESK_JIRA_EXTERNAL_ID,
    resolverOrder: resolverOrder as ResolverVia[],
    zendeskIdField: e.JIRA_ZENDESK_ID_FIELD,
    bundleTokenBudget: e.BUNDLE_TOKEN_BUDGET,
  };
}

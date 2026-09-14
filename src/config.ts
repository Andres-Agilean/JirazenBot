import { z } from 'zod';

export type ResolverVia = 'zendesk_links' | 'jira_zendesk_id_field';
const VIA_VALUES: ResolverVia[] = ['zendesk_links', 'jira_zendesk_id_field'];

// Jira custom field ids always look like this. JIRA_ZENDESK_ID_FIELD must match it because
// JiraClient.searchByZendeskId (src/fetch/jira.ts) builds its JQL filter by stripping the
// "customfield_" prefix off this value to get a bare field number for `cf[<n>]`; a value outside
// this shape would silently produce a bogus JQL filter instead of a clear error at config load.
const CUSTOM_FIELD_ID_PATTERN = /^customfield_\d+$/;

// Also assembleBundle's default `budgetTokens` (src/bundle/assemble.ts) -- named once here so
// the two spots that need "the default token budget" can't drift apart.
export const DEFAULT_BUNDLE_TOKEN_BUDGET = 25000;

// Claude model and token defaults used by the answer layer.
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
export const DEFAULT_CLAUDE_MAX_TOKENS = 2048;

// Error message when Claude features are used without an API key.
export const MISSING_ANTHROPIC_KEY_MESSAGE =
  'ANTHROPIC_API_KEY não está definido no .env — necessário para as respostas do Claude.';

// Base host for the Atlassian API gateway that fronts every Jira Cloud site. Requests go to
// `${ATLASSIAN_API_GATEWAY}/ex/jira/{ATLASSIAN_CLOUD_ID}`, never to ATLASSIAN_SITE_URL directly --
// see the Config.jiraApiBaseUrl / Config.siteUrl comment below for why.
const ATLASSIAN_API_GATEWAY = 'https://api.atlassian.com';

const EnvSchema = z.object({
  ATLASSIAN_SITE_URL: z.string().url(),
  ATLASSIAN_CLOUD_ID: z.string().min(1),
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
  ANTHROPIC_API_KEY: z.string().default(''),
  CLAUDE_MODEL: z.string().default(DEFAULT_CLAUDE_MODEL),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().default(DEFAULT_CLAUDE_MAX_TOKENS),
  // Azure Bot credentials (Phase 5a). Optional: their PRESENCE is what selects authenticated
  // mode -- see src/teams/authMode.ts for the fail-closed resolution.
  BOT_CLIENT_ID: z.string().default(''),
  BOT_CLIENT_SECRET: z.string().default(''),
  BOT_TENANT_ID: z.string().default(''),
  // Only the exact string 'true' (trimmed) opens unauthenticated mode. z.coerce.boolean() would
  // treat ANY non-empty string as true ('false' included) -- never use it for this flag.
  ALLOW_UNAUTHENTICATED: z.string().default(''),
});

export interface Config {
  /**
   * The URL we CALL: the Atlassian API gateway scoped to this tenant's cloud id
   * (`https://api.atlassian.com/ex/jira/{ATLASSIAN_CLOUD_ID}`). A modern *scoped* Atlassian API
   * token is only authorized against this gateway host -- calling ATLASSIAN_SITE_URL directly
   * with Basic auth returns 401/404 (see the design addendum §2.1 correction). JiraClient.get
   * must use this, never siteUrl.
   */
  jiraApiBaseUrl: string;
  /**
   * The URL we LINK a human to: the Jira site itself (`https://your-tenant.atlassian.net`),
   * used to build browse deep links (`{siteUrl}/browse/{KEY}`) in Phase 4 Teams cards. Display
   * only -- never pass this to fetch() for the REST API.
   */
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
  anthropicApiKey: string;
  claudeModel: string;
  claudeMaxTokens: number;
  /** Azure Bot (Entra app) client id; '' when running without credentials. */
  botClientId: string;
  /** Azure Bot client secret; '' when running without credentials. */
  botClientSecret: string;
  /** Entra tenant id of the single-tenant bot registration; '' when running without credentials. */
  botTenantId: string;
  /**
   * True ONLY when ALLOW_UNAUTHENTICATED=true (exact string, trimmed). Lets the bot start with no
   * Bot Framework auth for local M365 Agents Playground use. Never set on a hosted deployment.
   */
  allowUnauthenticated: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  const resolverOrder = e.RESOLVER_ORDER.split(',').map((s) => s.trim());
  for (const via of resolverOrder) {
    if (!VIA_VALUES.includes(via as ResolverVia)) {
      throw new Error(`RESOLVER_ORDER contém estratégia desconhecida: ${via}`);
    }
  }
  if (!CUSTOM_FIELD_ID_PATTERN.test(e.JIRA_ZENDESK_ID_FIELD)) {
    throw new Error(
      `JIRA_ZENDESK_ID_FIELD inválido: "${e.JIRA_ZENDESK_ID_FIELD}". Deve seguir o padrão ` +
        `"customfield_<número>" (ex.: customfield_10356) -- o id do campo do Jira que guarda o ` +
        `id do chamado Zendesk. Confira o id correto em Jira Admin > Campos personalizados.`,
    );
  }
  return {
    jiraApiBaseUrl: `${ATLASSIAN_API_GATEWAY}/ex/jira/${e.ATLASSIAN_CLOUD_ID}`,
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
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    claudeModel: e.CLAUDE_MODEL,
    claudeMaxTokens: e.CLAUDE_MAX_TOKENS,
    botClientId: e.BOT_CLIENT_ID.trim(),
    botClientSecret: e.BOT_CLIENT_SECRET.trim(),
    botTenantId: e.BOT_TENANT_ID.trim(),
    allowUnauthenticated: e.ALLOW_UNAUTHENTICATED.trim() === 'true',
  };
}

/** Throws when a Claude entry point is reached without an API key configured. */
export function requireAnthropicKey(cfg: Config): string {
  if (cfg.anthropicApiKey.trim() === '') throw new Error(MISSING_ANTHROPIC_KEY_MESSAGE);
  return cfg.anthropicApiKey;
}

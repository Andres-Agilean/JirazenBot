import type { Config } from '@/config.js';

/**
 * How the Teams app authenticates inbound/outbound Bot Framework traffic. Resolved fail-closed
 * (same asymmetry argument as the surface rule, CLAUDE.md hard rule 5): a misconfigured deploy
 * refusing to start is visible and annoying; a misconfigured deploy silently accepting forged
 * activities -- which can claim conversationType 'personal' and read internal Zendesk notes --
 * is silent and not undoable.
 */
export type AuthMode =
  | { mode: 'authenticated'; clientId: string; clientSecret: string; tenantId: string }
  | { mode: 'unauthenticated' };

/** The env var names, in the order they are reported when missing. */
const CREDENTIAL_VARS = ['BOT_CLIENT_ID', 'BOT_CLIENT_SECRET', 'BOT_TENANT_ID'] as const;

export const AUTH_NOT_CONFIGURED_MESSAGE =
  'Autenticação do bot não configurada. Defina BOT_CLIENT_ID, BOT_CLIENT_SECRET e BOT_TENANT_ID '
  + '(deploy autenticado), ou ALLOW_UNAUTHENTICATED=true para uso local com o M365 Agents '
  + 'Playground. Veja docs/deploy-azure.md.';

export function missingBotCredentialsMessage(missing: readonly string[]): string {
  return `Credenciais do bot incompletas: defina também ${missing.join(', ')}. `
    + 'Um bot parcialmente configurado nunca inicia sem autenticação (nem com ALLOW_UNAUTHENTICATED=true).';
}

type AuthConfig = Pick<Config, 'botClientId' | 'botClientSecret' | 'botTenantId' | 'allowUnauthenticated'>;

/**
 * Decision table (spec §3):
 *   all three credentials set            -> authenticated (ALLOW_UNAUTHENTICATED ignored)
 *   none set + ALLOW_UNAUTHENTICATED=true -> unauthenticated (Playground)
 *   none set, no flag                    -> throw
 *   partial credentials, flag or not     -> throw, naming the missing var(s)
 */
export function resolveAuthMode(cfg: AuthConfig): AuthMode {
  const values: Record<(typeof CREDENTIAL_VARS)[number], string> = {
    BOT_CLIENT_ID: cfg.botClientId.trim(),
    BOT_CLIENT_SECRET: cfg.botClientSecret.trim(),
    BOT_TENANT_ID: cfg.botTenantId.trim(),
  };
  const missing = CREDENTIAL_VARS.filter((name) => values[name] === '');

  if (missing.length === 0) {
    return {
      mode: 'authenticated',
      clientId: values.BOT_CLIENT_ID,
      clientSecret: values.BOT_CLIENT_SECRET,
      tenantId: values.BOT_TENANT_ID,
    };
  }
  if (missing.length === CREDENTIAL_VARS.length) {
    if (cfg.allowUnauthenticated) return { mode: 'unauthenticated' };
    throw new Error(AUTH_NOT_CONFIGURED_MESSAGE);
  }
  throw new Error(missingBotCredentialsMessage(missing));
}

/**
 * The exact option set handed to the SDK's App constructor -- kept here (SDK-free, offline-
 * testable) so app.ts only spreads it. AppOptions falls back to the CLIENT_ID / CLIENT_SECRET /
 * TENANT_ID / DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS env vars when an option is omitted
 * (app.d.ts); the explicit-pinning guarantee here is about the dangerous flag in authenticated
 * mode, which is always pinned to false rather than left to ambient environment. Unauthenticated
 * mode omits the credential keys entirely, so it is local-only (behind the explicit
 * ALLOW_UNAUTHENTICATED flag) rather than a guarantee that ambient CLIENT_ID / CLIENT_SECRET /
 * TENANT_ID cannot still feed outbound tokens in that mode.
 */
export type TeamsAppAuthOptions =
  | { clientId: string; clientSecret: string; tenantId: string; dangerouslyAllowUnauthenticatedRequests: false }
  | { dangerouslyAllowUnauthenticatedRequests: true };

export function appOptionsForAuthMode(mode: AuthMode): TeamsAppAuthOptions {
  if (mode.mode === 'authenticated') {
    return {
      clientId: mode.clientId,
      clientSecret: mode.clientSecret,
      tenantId: mode.tenantId,
      dangerouslyAllowUnauthenticatedRequests: false,
    };
  }
  return { dangerouslyAllowUnauthenticatedRequests: true };
}

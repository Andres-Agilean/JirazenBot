import { describe, expect, it } from 'vitest';
import {
  AUTH_NOT_CONFIGURED_MESSAGE,
  appOptionsForAuthMode,
  missingBotCredentialsMessage,
  resolveAuthMode,
} from '@/teams/authMode.js';

const fullCreds = {
  botClientId: '11111111-1111-1111-1111-111111111111',
  botClientSecret: 's3cret',
  botTenantId: '22222222-2222-2222-2222-222222222222',
  allowUnauthenticated: false,
};

const noCreds = { botClientId: '', botClientSecret: '', botTenantId: '', allowUnauthenticated: false };

describe('resolveAuthMode', () => {
  it('returns authenticated mode when all three credentials are set', () => {
    expect(resolveAuthMode(fullCreds)).toEqual({
      mode: 'authenticated',
      clientId: fullCreds.botClientId,
      clientSecret: fullCreds.botClientSecret,
      tenantId: fullCreds.botTenantId,
    });
  });

  it('credentials win over the flag: full credentials + ALLOW_UNAUTHENTICATED=true is authenticated', () => {
    expect(resolveAuthMode({ ...fullCreds, allowUnauthenticated: true }).mode).toBe('authenticated');
  });

  it('returns unauthenticated mode only with no credentials AND the explicit flag', () => {
    expect(resolveAuthMode({ ...noCreds, allowUnauthenticated: true })).toEqual({ mode: 'unauthenticated' });
  });

  it('refuses to start with no credentials and no flag', () => {
    expect(() => resolveAuthMode(noCreds)).toThrow(AUTH_NOT_CONFIGURED_MESSAGE);
  });

  it.each([
    ['BOT_CLIENT_ID', { ...fullCreds, botClientId: '' }, ['BOT_CLIENT_ID']],
    ['BOT_CLIENT_SECRET', { ...fullCreds, botClientSecret: '' }, ['BOT_CLIENT_SECRET']],
    ['BOT_TENANT_ID', { ...fullCreds, botTenantId: '' }, ['BOT_TENANT_ID']],
  ])('refuses to start on partial credentials, naming the missing var (%s)', (_name, cfg, missing) => {
    expect(() => resolveAuthMode(cfg)).toThrow(missingBotCredentialsMessage(missing));
  });

  it('partial credentials refuse to start EVEN WITH the flag set (a half-configured bot never opens)', () => {
    expect(() => resolveAuthMode({ ...fullCreds, botClientSecret: '', allowUnauthenticated: true }))
      .toThrow(missingBotCredentialsMessage(['BOT_CLIENT_SECRET']));
  });

  it('names every missing var when two are absent', () => {
    expect(() => resolveAuthMode({ ...fullCreds, botClientId: '', botTenantId: '' }))
      .toThrow(missingBotCredentialsMessage(['BOT_CLIENT_ID', 'BOT_TENANT_ID']));
  });

  it('treats whitespace-only values as unset (stray .env space)', () => {
    expect(() => resolveAuthMode({ ...fullCreds, botClientSecret: '   ' }))
      .toThrow(missingBotCredentialsMessage(['BOT_CLIENT_SECRET']));
  });
});

describe('appOptionsForAuthMode', () => {
  it('maps authenticated mode to explicit credentials with the dangerous flag pinned to false', () => {
    // Pinning matters: the SDK falls back to the DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS env
    // var when the option is not explicitly provided (app.d.ts) -- an ambient env var must never
    // be able to open an authenticated deployment.
    expect(appOptionsForAuthMode(resolveAuthMode(fullCreds))).toEqual({
      clientId: fullCreds.botClientId,
      clientSecret: fullCreds.botClientSecret,
      tenantId: fullCreds.botTenantId,
      dangerouslyAllowUnauthenticatedRequests: false,
    });
  });

  it('maps unauthenticated mode to the dangerous flag alone — no credential keys present at all', () => {
    const opts = appOptionsForAuthMode(resolveAuthMode({ ...noCreds, allowUnauthenticated: true }));
    expect(opts).toEqual({ dangerouslyAllowUnauthenticatedRequests: true });
    expect(Object.keys(opts)).not.toContain('clientId');
  });
});

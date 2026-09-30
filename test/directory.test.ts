import { describe, expect, it, vi } from 'vitest';
import { GraphDirectoryClient } from '@/msgraph/directory.js';

const creds = { tenantId: 't', clientId: 'c', clientSecret: 's' };
const token = { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
const users = (value: unknown[]) => ({ ok: true, status: 200, json: async () => ({ value }) });

it('requests a client-credentials token, then searches users members-only', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(token as Response)
    .mockResolvedValueOnce(users([{ id: '1', displayName: 'João Silva', mail: 'joao@org.com' }]) as Response);
  const client = new GraphDirectoryClient(creds, fetchFn as unknown as typeof fetch);
  const result = await client.searchByName('João Silva');
  expect(result).toEqual([{ id: '1', displayName: 'João Silva', mail: 'joao@org.com' }]);
  const tokenUrl = fetchFn.mock.calls[0][0] as string;
  expect(tokenUrl).toContain('login.microsoftonline.com/t/oauth2/v2.0/token');
  const searchUrl = fetchFn.mock.calls[1][0] as string;
  expect(searchUrl).toContain("userType eq 'Member'");
  expect(searchUrl).toContain('accountEnabled eq true');
  expect(searchUrl).toContain(encodeURIComponent('João Silva').replace(/'/g, '%27'));
  const headers = (fetchFn.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
  expect(headers.Authorization).toBe('Bearer tok');
});

it("escapes single quotes in the name (O'Brien) so the OData filter stays inert", async () => {
  const fetchFn = vi.fn().mockResolvedValueOnce(token as Response).mockResolvedValueOnce(users([]) as Response);
  const client = new GraphDirectoryClient(creds, fetchFn as unknown as typeof fetch);
  await client.searchByName("O'Brien");
  expect(decodeURIComponent(fetchFn.mock.calls[1][0] as string)).toContain("O''Brien");
});

it('reuses an unexpired token across searches', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(token as Response)
    .mockResolvedValueOnce(users([]) as Response)
    .mockResolvedValueOnce(users([]) as Response);
  const client = new GraphDirectoryClient(creds, fetchFn as unknown as typeof fetch);
  await client.searchByName('a b'); await client.searchByName('c d');
  expect(fetchFn).toHaveBeenCalledTimes(3); // one token, two searches
});

it('search failure is one thrown error, no retry (Review Focus 5)', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(token as Response)
    .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as Response);
  const client = new GraphDirectoryClient(creds, fetchFn as unknown as typeof fetch);
  await expect(client.searchByName('x y')).rejects.toThrow();
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

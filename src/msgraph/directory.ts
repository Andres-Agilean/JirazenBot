/** Org-directory lookup for the reminder feature (spec §4). Plain fetch — no Teams SDK. */
export interface DirectoryUser { id: string; displayName: string; mail: string | null }
export interface DirectoryClientLike { searchByName(name: string): Promise<DirectoryUser[]> }

export const DIRECTORY_UNAVAILABLE = 'Não consegui consultar o diretório agora. Tente novamente em instantes.';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_SCOPE = 'https://graph.microsoft.com/.default';
/** Refresh 60s early so a token never expires mid-request. */
const TOKEN_SKEW_MS = 60_000;
/** Members only, enabled only (spec §4): guests and disabled accounts are never candidates. */
const MEMBER_FILTER = "userType eq 'Member' and accountEnabled eq true";
const PAGE_SIZE = 25;

interface Creds { tenantId: string; clientId: string; clientSecret: string }

export class GraphDirectoryClient implements DirectoryClientLike {
  private token?: { value: string; expiresAt: number };
  constructor(private readonly creds: Creds, private readonly fetchFn: typeof fetch = fetch) {}

  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const body = new URLSearchParams({
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: TOKEN_SCOPE,
      grant_type: 'client_credentials',
    });
    const res = await this.fetchFn(
      `https://login.microsoftonline.com/${this.creds.tenantId}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    );
    if (!res.ok) throw new Error(`Graph token: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 - TOKEN_SKEW_MS };
    return json.access_token;
  }

  /** First page only, no retries (§6a spirit): a 429/5xx surfaces as one thrown error. */
  async searchByName(name: string): Promise<DirectoryUser[]> {
    const escaped = name.replace(/'/g, "''");
    const encodedName = encodeURIComponent(escaped);
    const filter = `startswith(displayName,'${encodedName}') and ${MEMBER_FILTER}`;
    const url = `${GRAPH_BASE}/users?$filter=${filter}&$select=id,displayName,mail&$top=${PAGE_SIZE}`;
    const res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${await this.bearer()}` } });
    if (!res.ok) throw new Error(`Graph users: HTTP ${res.status}`);
    const json = (await res.json()) as { value: Array<{ id: string; displayName?: string; mail?: string | null }> };
    return json.value.map((u) => ({ id: u.id, displayName: u.displayName ?? '', mail: u.mail ?? null }));
  }
}

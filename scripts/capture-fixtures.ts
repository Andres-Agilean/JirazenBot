import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { scrubEmails } from '../src/fetch/scrub.js';

// Any 2xx is an acceptable capture response; anything else is an error body, not a fixture.
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
function isHttpOk(status: number): boolean {
  return status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
}

const [ticketId = '16560', issueKey = 'AGL-1658'] = process.argv.slice(2);
const cfg = loadConfig();
const dir = 'test/fixtures/live';
mkdirSync(dir, { recursive: true });

function save(name: string, data: unknown): void {
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(scrubEmails(data), null, 2));
  console.log(`gravado ${dir}/${name}.json`);
}

const jiraAuth = 'Basic ' + Buffer.from(`${cfg.atlassianEmail}:${cfg.atlassianToken}`).toString('base64');
const zdAuth = 'Basic ' + Buffer.from(`${cfg.zendeskEmail}/token:${cfg.zendeskToken}`).toString('base64');

async function grab(url: string, auth: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

// Fetches `endpointLabel` and saves it as fixture `name` only on a 2xx response. A non-2xx
// response (e.g. an unauthenticated-looking Jira 404 body, or a Zendesk 401/403) is an error
// body, not a fixture -- writing it as one would silently poison the fixture set (this is exactly
// what happened before this check existed: jira-issue.json and jira-comments.json held Jira's
// "no such issue or no permission" error body). Returns whether the capture succeeded so the
// caller can bail out with a non-zero exit instead of continuing to build on a broken run.
async function captureOrFail(name: string, endpointLabel: string, url: string, auth: string): Promise<boolean> {
  const { status, body } = await grab(url, auth);
  if (!isHttpOk(status)) {
    console.error(`Falha ao capturar ${endpointLabel}: HTTP ${status}. Corpo da resposta: ${JSON.stringify(body)}`);
    return false;
  }
  save(name, body);
  return true;
}

async function main(): Promise<void> {
  const jiraIssueUrl = `${cfg.jiraApiBaseUrl}/rest/api/3/issue/${issueKey}?expand=changelog,names`;
  if (!(await captureOrFail('jira-issue', `Jira issue ${issueKey}`, jiraIssueUrl, jiraAuth))) {
    process.exitCode = 1;
    return;
  }

  const jiraCommentsUrl = `${cfg.jiraApiBaseUrl}/rest/api/3/issue/${issueKey}/comment?maxResults=100`;
  if (!(await captureOrFail('jira-comments', `comentários de ${issueKey}`, jiraCommentsUrl, jiraAuth))) {
    process.exitCode = 1;
    return;
  }

  const zendeskTicketUrl = `https://${cfg.zendeskSubdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  if (!(await captureOrFail('zendesk-ticket', `chamado Zendesk ${ticketId}`, zendeskTicketUrl, zdAuth))) {
    process.exitCode = 1;
    return;
  }

  const zendeskCommentsUrl = `https://${cfg.zendeskSubdomain}.zendesk.com/api/v2/tickets/${ticketId}/comments.json?include=users`;
  if (!(await captureOrFail('zendesk-comments', `comentários do chamado ${ticketId}`, zendeskCommentsUrl, zdAuth))) {
    process.exitCode = 1;
    return;
  }

  // The links probe is the one exception: its whole purpose is to record whatever status comes
  // back (200 with data, or the 403 this tenant currently returns) so that status decides
  // RESOLVER_ORDER -- a non-200 here is a signal to record, not a failed capture to abort on.
  const probe = await grab(
    `https://${cfg.zendeskSubdomain}.zendesk.com/api/v2/integrations/jira/${cfg.zendeskJiraExternalId}/links?ticket_id=${ticketId}`,
    zdAuth,
  );
  save('links-api-probe', probe);
  console.log(probe.status === 200
    ? 'links API OK — mantenha RESOLVER_ORDER=zendesk_links,jira_zendesk_id_field'
    : `links API respondeu ${probe.status} — use RESOLVER_ORDER=jira_zendesk_id_field,zendesk_links até liberar "Manage links"`);

  console.warn(
    '\nAVISO: os arquivos em test/fixtures/live/ contêm dados reais de clientes não totalmente ' +
    'anonimizados (scrubEmails só remove e-mails; nomes, telefones, endereços e números de ' +
    'contrato podem permanecer nos corpos dos comentários do Zendesk). Esse diretório está no ' +
    '.gitignore -- revise cada arquivo manualmente antes de adicioná-lo à força (git add -f) e ' +
    'nunca faça isso sem essa revisão.',
  );
}

await main();

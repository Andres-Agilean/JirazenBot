import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { scrubEmails } from '../src/fetch/scrub.js';

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

const issue = await grab(`${cfg.siteUrl}/rest/api/3/issue/${issueKey}?expand=changelog,names`, jiraAuth);
save('jira-issue', issue.body);
save('jira-comments', (await grab(`${cfg.siteUrl}/rest/api/3/issue/${issueKey}/comment?maxResults=100`, jiraAuth)).body);
save('zendesk-ticket', (await grab(`https://${cfg.zendeskSubdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`, zdAuth)).body);
save('zendesk-comments', (await grab(`https://${cfg.zendeskSubdomain}.zendesk.com/api/v2/tickets/${ticketId}/comments.json?include=users`, zdAuth)).body);

const probe = await grab(
  `https://${cfg.zendeskSubdomain}.zendesk.com/api/v2/integrations/jira/${cfg.zendeskJiraExternalId}/links?ticket_id=${ticketId}`,
  zdAuth,
);
save('links-api-probe', probe);
console.log(probe.status === 200
  ? 'links API OK — mantenha RESOLVER_ORDER=zendesk_links,jira_zendesk_id_field'
  : `links API respondeu ${probe.status} — use RESOLVER_ORDER=jira_zendesk_id_field,zendesk_links até liberar "Manage links"`);

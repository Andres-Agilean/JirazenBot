import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { parseReference } from '../src/resolve/parseReference.js';
import { ZendeskLinksStrategy, JiraFieldStrategy, type ResolverStrategy } from '../src/resolve/strategies.js';
import { Resolver } from '../src/resolve/resolver.js';
import { JiraClient } from '../src/fetch/jira.js';
import { ZendeskClient } from '../src/fetch/zendesk.js';
import { assembleBundle } from '../src/bundle/assemble.js';
import { renderBundle } from '../src/bundle/render.js';
import { parseCardArgs } from './parseCardArgs.js';

const { refText, surface } = parseCardArgs(process.argv.slice(2));

const cfg = loadConfig();
const ref = parseReference(refText, cfg.allowedProjects);
if (!ref) {
  console.error('Uso: npm run card -- <PROJ-123 | chamado 4471 | URL> [--surface dm|multiparty]');
  process.exit(2);
}

const jira = new JiraClient(cfg);
const zendesk = new ZendeskClient(cfg);
const byName: Record<string, ResolverStrategy> = {
  zendesk_links: new ZendeskLinksStrategy(cfg),
  jira_zendesk_id_field: new JiraFieldStrategy(jira, cfg),
};
const resolver = new Resolver(cfg.resolverOrder.map((n) => byName[n]));

const result = await assembleBundle(ref, { jira, zendesk, resolver }, surface, undefined, cfg.bundleTokenBudget);

if (result.status === 'ok') {
  console.log(renderBundle(result.bundle));
} else if (result.status === 'ambiguous') {
  console.error(`Referência ambígua (${result.side}): ${result.candidates.join(', ')}`);
  process.exit(1);
} else {
  console.error(result.message);
  process.exit(1);
}

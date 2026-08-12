import type { Config } from '../config.js';
import type { CardRef } from '../resolve/types.js';
import { JiraClient } from '../fetch/jira.js';
import { ZendeskClient } from '../fetch/zendesk.js';
import { Resolver } from '../resolve/resolver.js';
import { JiraFieldStrategy, ZendeskLinksStrategy, type ResolverStrategy } from '../resolve/strategies.js';
import { assembleBundle, type AssembleResult } from './assemble.js';
import type { Surface } from './types.js';

/** Builds the resolver with its strategies in cfg.resolverOrder priority order. */
export function buildResolver(cfg: Config, jira: JiraClient): Resolver {
  const byName: Record<string, ResolverStrategy> = {
    zendesk_links: new ZendeskLinksStrategy(cfg),
    jira_zendesk_id_field: new JiraFieldStrategy(jira, cfg),
  };
  return new Resolver(cfg.resolverOrder.map((n) => byName[n]));
}

/**
 * Reference -> fully assembled, budgeted bundle. Shared by both CLIs so the card path and the
 * ask path can never drift apart in how they resolve or assemble.
 */
export function loadCardBundle(
  ref: CardRef,
  cfg: Config,
  surface: Surface,
): Promise<AssembleResult> {
  const jira = new JiraClient(cfg);
  const zendesk = new ZendeskClient(cfg);
  const resolver = buildResolver(cfg, jira);
  return assembleBundle(ref, { jira, zendesk, resolver }, surface, undefined, cfg.bundleTokenBudget);
}

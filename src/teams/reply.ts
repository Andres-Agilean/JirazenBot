import type { Config } from '@/config.js';
import type { CardBundle } from '@/bundle/types.js';
import type { Binding } from './bindings.js';

/** Users are in Brazil; a UTC timestamp in the footer reads as the wrong time by three hours. */
export const DISPLAY_TIMEZONE = 'America/Sao_Paulo';

const TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: DISPLAY_TIMEZONE,
});

/** Human-facing deep link: Config.siteUrl, never jiraApiBaseUrl (addendum §2.1). */
export function jiraLink(issueKey: string, cfg: Config): string {
  return `${cfg.siteUrl}/browse/${issueKey}`;
}

export function zendeskLink(ticketId: string, cfg: Config): string {
  return `https://${cfg.zendeskSubdomain}.zendesk.com/agent/tickets/${ticketId}`;
}

/** The bundle's collection time as HH:mm in Brazil local time. Shared with the card header. */
export function collectedAt(bundle: Pick<CardBundle, 'fetchedAt'>): string {
  return TIME_FORMAT.format(new Date(bundle.fetchedAt));
}

/** A collection instant (epoch ms, as stored on a candidate set) as HH:mm; same formatting as `collectedAt`. */
export const collectedTime = (collectedAtMs: number): string =>
  collectedAt({ fetchedAt: new Date(collectedAtMs).toISOString() });

/**
 * Which card this is, as markdown deep links: `[QZ-252](…) ↔ [chamado 16467](…)`, omitting
 * whichever side the bundle lacks.
 *
 * Shared by the text footer and the Adaptive Card header. The card header used to build its own
 * unlinked copy of this string, so the key and ticket number rendered as dead text in the card
 * while the identical footer text was clickable. Adaptive Card TextBlocks render markdown links,
 * so one definition serves both — keep it that way.
 */
export function cardIdentity(bundle: CardBundle, cfg: Config): string {
  const parts: string[] = [];
  const { jira, zendesk } = bundle;
  if (jira) parts.push(`[${jira.issueKey}](${jiraLink(jira.issueKey, cfg)})`);
  if (zendesk) {
    parts.push(`[chamado ${zendesk.ticketId}](${zendeskLink(zendesk.ticketId, cfg)})`);
  }
  return parts.join(' ↔ ');
}

/**
 * Rendered under every answer so the user never has to guess which card the bot thinks it is
 * discussing, or how fresh the data is (plan §9.3, §7.5).
 */
export function formatFooter(binding: Binding, cfg: Config): string {
  return `— ${cardIdentity(binding.bundle, cfg)} · coletado às ${collectedAt(binding.bundle)}`;
}

export function withFooter(answerText: string, binding: Binding, cfg: Config): string {
  return `${answerText}\n\n${formatFooter(binding, cfg)}`;
}

/**
 * What a handler sends back to the Teams adapter: either a plain text message (existing text
 * command path) or an Adaptive Card with a plain-text fallback for clients that can't render
 * cards (Task 6 wires this in; this task only defines the shape).
 */
export type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'card'; card: Record<string, unknown>; fallbackText: string };

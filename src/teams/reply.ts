import type { Config } from '@/config.js';
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

/**
 * Rendered under every answer so the user never has to guess which card the bot thinks it is
 * discussing, or how fresh the data is (plan §9.3, §7.5).
 */
export function formatFooter(binding: Binding, cfg: Config): string {
  const parts: string[] = [];
  const { jira, zendesk } = binding.bundle;
  if (jira) parts.push(`[${jira.issueKey}](${jiraLink(jira.issueKey, cfg)})`);
  if (zendesk) {
    parts.push(`[chamado ${zendesk.ticketId}](${zendeskLink(zendesk.ticketId, cfg)})`);
  }
  const time = TIME_FORMAT.format(new Date(binding.bundle.fetchedAt));
  return `— ${parts.join(' ↔ ')} · coletado às ${time}`;
}

export function withFooter(answerText: string, binding: Binding, cfg: Config): string {
  return `${answerText}\n\n${formatFooter(binding, cfg)}`;
}

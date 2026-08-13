import type { CardRef } from './types.js';

const ZENDESK_URL = /https?:\/\/[\w-]+\.zendesk\.com\/(?:agent\/)?tickets?\/(\d+)/i;
const JIRA_URL = /https?:\/\/[\w.-]+\.atlassian\.net\/\S*?\b([A-Z][A-Z0-9]+-\d+)\b/;
const ISSUE_KEY = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;
/**
 * "chamado" and "ticket" are used interchangeably by the tenant's staff, and both get pluralised
 * ("os tickets 16467"). The number may be separated from the keyword by a colon, a dash, a "#",
 * or an ordinal filler ("ticket nº 16467") — the original singular-only, whitespace-or-#-only
 * form silently parsed none of those, so the bot answered "which card?" to a perfectly explicit
 * reference. The keyword must still immediately precede the digits, which is what keeps
 * "abrimos 3 tickets essa semana" from matching.
 */
const KEYWORD_TICKET =
  /(?:^|\s)(?:chamados?|tickets?|zd)\s*(?:número|numero|n[º°o]?\.?)?\s*[:#–—-]?\s*(\d+)\b/i;
const HASH_TICKET = /#(\d+)\b/;
const WHOLE_MESSAGE_NUMBER = /^\s*(\d{2,})\s*[?.!]*\s*$/;

export function parseReference(text: string, allowedProjects: string[]): CardRef | null {
  const zUrl = text.match(ZENDESK_URL);
  if (zUrl) return { system: 'zendesk', ticketId: zUrl[1], explicit: true };

  const jUrl = text.match(JIRA_URL);
  if (jUrl) {
    const keyMatch = jUrl[1].match(/^([A-Z][A-Z0-9]+)-(\d+)$/);
    if (keyMatch && allowedProjects.includes(keyMatch[1])) {
      return { system: 'jira', issueKey: jUrl[1], explicit: true };
    }
  }

  for (const match of text.matchAll(ISSUE_KEY)) {
    if (allowedProjects.includes(match[1])) {
      return { system: 'jira', issueKey: `${match[1]}-${match[2]}`, explicit: true };
    }
  }

  const kw = text.match(KEYWORD_TICKET);
  if (kw) return { system: 'zendesk', ticketId: kw[1], explicit: true };

  const hash = text.match(HASH_TICKET);
  if (hash) return { system: 'zendesk', ticketId: hash[1], explicit: true };

  const bare = text.match(WHOLE_MESSAGE_NUMBER);
  if (bare) return { system: 'zendesk', ticketId: bare[1], explicit: false };

  return null;
}

import type { CardBundle } from '@/bundle/types.js';
import { formatDayMonthTime } from '@/text/datetime.js';

/**
 * Display-time citation compression for Teams replies.
 *
 * CLAUDE.md: citation styling happens at display time, never in the prompt. The model, the
 * grounding eval (`mustCite` matches the exact bracketed form) and the CLI all see the raw,
 * verbose citations; only the text rendered into a Teams reply is shortened here.
 *
 * With the bundle, a comment id becomes the comment's timestamp (DD/MM HH:mm, Sao Paulo):
 *   [comentário jira 41713]            -> [jira 11/08 14:34]
 *   [comentário zendesk 40123456789]   -> [zendesk 14/08 11:52]
 * When the id is not in the bundle (or no bundle is passed), fall back to the id forms:
 *   [comentário jira 41713]            -> [jira 41713]
 *   [comentário zendesk 1234567890]    -> [zendesk …7890]   (ids over 6 digits keep the last 4)
 *   [comentário zendesk 90001]         -> [zendesk 90001]
 *   [campo Status]                     -> [Status]
 *
 * Idempotent: the regexes only match digit-only ids, so compressed output (which starts with a
 * digit-and-slash timestamp or an ellipsis) never matches again. Everything else is untouched.
 */
const ZENDESK_FULL_ID_MAX_DIGITS = 6;
const ZENDESK_ELIDED_TAIL_DIGITS = 4;

export function compressCitations(text: string, bundle?: CardBundle): string {
  const jiraAt = new Map((bundle?.jira?.comments ?? []).map((c) => [String(c.id), c.createdAt]));
  const zendeskAt = new Map((bundle?.zendesk?.comments ?? []).map((c) => [String(c.id), c.createdAt]));
  return text
    .replace(/\[comentário jira (\d+)\]/g, (_match, id: string) => {
      const at = jiraAt.get(id);
      return `[jira ${at ? formatDayMonthTime(at) : id}]`;
    })
    .replace(/\[comentário zendesk (\d+)\]/g, (_match, id: string) => {
      const at = zendeskAt.get(id);
      if (at) return `[zendesk ${formatDayMonthTime(at)}]`;
      return id.length > ZENDESK_FULL_ID_MAX_DIGITS
        ? `[zendesk …${id.slice(-ZENDESK_ELIDED_TAIL_DIGITS)}]`
        : `[zendesk ${id}]`;
    })
    .replace(/\[campo ([^\]]+)\]/g, '[$1]');
}

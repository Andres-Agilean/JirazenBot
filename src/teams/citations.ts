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
 * A comma tail after the id (`[comentário jira 41713, André Marques]`) is accepted and dropped.
 *
 * Idempotent: re-running is safe because the `comentário ` / `campo ` prefix is consumed by the
 * first pass, so its output no longer matches. (`[nota interna <id>]` keeps its label, but its
 * output is a timestamp or an ellipsis form, and a short raw id maps to itself.) Everything else
 * is untouched.
 */
const ZENDESK_FULL_ID_MAX_DIGITS = 6;
const ZENDESK_ELIDED_TAIL_DIGITS = 4;
const ZENDESK_LABEL = 'comentário zendesk';

export function compressCitations(text: string, bundle?: CardBundle): string {
  const jiraAt = new Map((bundle?.jira?.comments ?? []).map((c) => [String(c.id), c.createdAt]));
  const zendeskAt = new Map((bundle?.zendesk?.comments ?? []).map((c) => [String(c.id), c.createdAt]));
  return text
    .replace(/\[comentário jira (\d+)(?:,[^\]]*)?\]/g, (_match, id: string) => {
      const at = jiraAt.get(id);
      return `[jira ${at ? formatDayMonthTime(at) : id}]`;
    })
    // `[nota interna <id>]` is a defensive match for a label the model sometimes invents (the
    // prompt forbids it); it is handled exactly like a zendesk comment, keeping its own label.
    .replace(/\[(comentário zendesk|nota interna) (\d+)(?:,[^\]]*)?\]/g, (_match, label: string, id: string) => {
      const shown = label === ZENDESK_LABEL ? 'zendesk' : label;
      const at = zendeskAt.get(id);
      if (at) return `[${shown} ${formatDayMonthTime(at)}]`;
      return id.length > ZENDESK_FULL_ID_MAX_DIGITS
        ? `[${shown} …${id.slice(-ZENDESK_ELIDED_TAIL_DIGITS)}]`
        : `[${shown} ${id}]`;
    })
    .replace(/\[campo ([^\]]+)\]/g, '[$1]');
}

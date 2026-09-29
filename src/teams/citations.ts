/**
 * Display-time citation compression for Teams replies.
 *
 * CLAUDE.md: citation styling happens at display time, never in the prompt. The model, the
 * grounding eval (`mustCite` matches the exact bracketed form) and the CLI all see the raw,
 * verbose citations; only the text rendered into a Teams reply is shortened here.
 *
 *   [comentário jira 123]              -> [jira 123]
 *   [comentário zendesk 1234567890]    -> [zendesk …7890]   (ids over 6 digits keep the last 4)
 *   [comentário zendesk 90001]         -> [zendesk 90001]
 *   [campo Status]                     -> [Status]
 *
 * Idempotent: compressed output no longer matches any pattern. Everything else is untouched.
 */
const ZENDESK_FULL_ID_MAX_DIGITS = 6;
const ZENDESK_ELIDED_TAIL_DIGITS = 4;

export function compressCitations(text: string): string {
  return text
    .replace(/\[comentário jira (\d+)\]/g, '[jira $1]')
    .replace(/\[comentário zendesk (\d+)\]/g, (_match, id: string) =>
      id.length > ZENDESK_FULL_ID_MAX_DIGITS
        ? `[zendesk …${id.slice(-ZENDESK_ELIDED_TAIL_DIGITS)}]`
        : `[zendesk ${id}]`,
    )
    .replace(/\[campo ([^\]]+)\]/g, '[$1]');
}

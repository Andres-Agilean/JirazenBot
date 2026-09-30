import type { CardBundle } from '@/bundle/types.js';
import type { Config } from '@/config.js';
import { formatDayMonthTime } from '@/text/datetime.js';
import type { CandidateSet } from './candidates.js';
import { jiraLink, zendeskLink } from './reply.js';

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
    .replace(/\[campo ([^\]]+)\]/g, '[$1]')
    .replace(STATS_PHRASE, '')
    .replace(STATS_LABEL, (_match, before: string, after: string, punct: string, offset: number, whole: string) => {
      if (punct) return punct;
      return before || after ? (offset + _match.length >= whole.length ? '' : ' ') : '';
    })
    .replace(LEADING_PUNCTUATION, '$1$2');
}

/** Punctuation stranded at a line start (optionally behind a `**` opener) once a leading label phrase is gone. */
const LEADING_PUNCTUATION = /(^|\n)([ \t]*(?:\*{1,2}[ \t]*)?)[:;,][ \t]+/g;

/**
 * The `[estatísticas]` block label is internal (spec §13, amending §5's passthrough): the prompt
 * and the eval keep it, but it must never reach the user. The phrase form ("..., conforme
 * [estatísticas]:") disappears whole; a bare remainder is removed with its spacing tidied.
 * Accepts the unaccented spelling the model sometimes emits.
 */
const STATS_LABEL_SOURCE = '\\[estat[íi]sticas\\]';
const STATS_PHRASE = new RegExp(`,?[ \\t]*\\b(?:conforme|segundo)[ \\t]+(?:o[ \\t]+bloco[ \\t]+)?${STATS_LABEL_SOURCE}`, 'gi');
const STATS_LABEL = new RegExp(`([ \\t]*)${STATS_LABEL_SOURCE}([ \\t]*)([.,;:!?]?)`, 'gi');

/** An existing `**bold**` span, or a markdown link: pieces the styling pass must not modify. */
const BOLD_SPAN = /(\*\*[\s\S]+?\*\*)/;
const PROTECTED_SPAN = /(\*\*[\s\S]*?\*\*|\[[^\]]*\]\([^)]*\))/;
/** A bracketed candidate label: a Jira key or `chamado N` (the shapes `CardCandidate.label` takes). */
const CANDIDATE_CITATION = /\[([A-Z][A-Z0-9]*-\d+|chamado \d+)\](?!\()/g;
const CHAMADO_PREFIX = 'chamado ';
/** Letters and digits: a known string only matches where it is not glued to a longer word. */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `[QZ-308]` -> `[QZ-308](jira url)`, `[chamado 17063]` -> `[chamado 17063](zendesk url)`; `wrap` adds the bold. */
function linkifyCitations(text: string, cfg: Config, wrap: (link: string) => string): string {
  return text.replace(CANDIDATE_CITATION, (_match, label: string) => {
    const url = label.startsWith(CHAMADO_PREFIX)
      ? zendeskLink(label.slice(CHAMADO_PREFIX.length), cfg)
      : jiraLink(label, cfg);
    return wrap(`[${label}](${url})`);
  });
}

/** A regex matching any of the set's statuses and assignee names verbatim (longest first), or null when it has none. */
function knownStringsPattern(candidates: CandidateSet['candidates']): RegExp | null {
  const known = new Set(candidates.flatMap((c) => [c.status, c.assignee ?? '']).filter((s) => s.trim() !== ''));
  if (known.size === 0) return null;
  const alternatives = [...known].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`(?<!${WORD_CHAR})(?:${alternatives})(?!${WORD_CHAR})`, 'gu');
}

/** Applies `fn` to the pieces of `text` that `separator` (one capture group) does NOT capture. */
const mapOutside = (text: string, separator: RegExp, fn: (piece: string) => string): string =>
  text.split(separator).map((piece, i) => (i % 2 === 1 ? piece : fn(piece))).join('');

/**
 * Display-time styling of a Claude-over-portfolio answer, so prose reads like the deterministic
 * cards (spec §14): the `[estatísticas]` strip first (shared with `compressCitations`), candidate
 * citations as bold links, then every status and assignee of the stored set in bold. Existing bold
 * spans and link text are never modified, so bold never nests. History keeps the raw text.
 */
export function stylePortfolioAnswer(text: string, set: Pick<CandidateSet, 'candidates'>, cfg: Config): string {
  const known = knownStringsPattern(set.candidates);
  return compressCitations(text)
    .split(BOLD_SPAN)
    .map((piece, i) => {
      // Inside a bold span a citation becomes a plain link (it inherits the outer bold).
      if (i % 2 === 1) return linkifyCitations(piece, cfg, (link) => link);
      const linked = linkifyCitations(piece, cfg, (link) => `**${link}**`);
      return known ? mapOutside(linked, PROTECTED_SPAN, (part) => part.replace(known, '**$&**')) : linked;
    })
    .join('');
}

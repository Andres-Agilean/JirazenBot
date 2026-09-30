import { normalizeText } from '@/text/normalize.js';

/** Explicit search command: works anytime, including with a card bound (spec §3). */
export const BUSCAR_COMMAND = 'buscar';

export interface PortfolioQuery {
  /** The name as the user typed it (original case and accents) — it goes to vendors verbatim. */
  name: string;
  /** 'candidates' when the phrasing asks about ONE thing; 'rundown' for an overview. */
  mode: 'rundown' | 'candidates';
}

const MAX_NAME_LENGTH = 60;

/** The entity words that anchor a vague query (spec §4: empresa/cliente via Zendesk, obra/projeto via Jira text). */
const KIND = /\b(?:empresa|cliente|obra|projeto)\b/;
/** Words that mark the question as being about one card, not a portfolio (spec §5). */
const CARD_SHAPE = /\b(?:problema|erro|bug|card|chamado|ticket|incidente)\b/;
/** Leading connectives between the kind word and the name. */
const CONNECTIVE = /^(?:(?:d[aeo]s?|n[ao]s?|em)\s+)?/;
/** Names that are almost certainly a verb/stray word, not an entity (false-positive guard). */
const STOP_NAMES = new Set(['atrasou', 'atrasada', 'parou', 'parada', 'anda', 'esta', 'estao']);

/** Plural subject words (normalized): also anchors, but always a rundown (spec §10.1). */
const PLURAL_KIND = /\b(?:cards|atividades|chamados|tickets|pendencias|demandas)\b/;

const NAME_AFTER_PLURAL = new RegExp(`${PLURAL_KIND.source}\\s+(.+)$`);
const NAME_AFTER_KIND =new RegExp(`${KIND.source}\\s+(.+)$`);

/**
 * Whole-message bare-name shapes, matched on folded text (spec §10.4): "qual o status da X",
 * "como está a X". Group 1 is always the name tail.
 */
const LOOSE_SHAPES: readonly RegExp[] = [
  /^qual\s+(?:(?:e|eh)\s+)?(?:o|a)\s+(?:status|andamento|situacao)\s+(?:atual\s+)?d[aeo]s?\s+(.+)$/,
  /^como\s+(?:esta|estao|anda|andam)\s+(?:(?:o|a|os|as)\s+)?(.+)$/,
];
/** Normalized tails that point at one specific card, so the loose shapes must leave them alone. */
const REFERENCE_SHAPED: readonly RegExp[] = [
  /^[a-z][a-z0-9]*-\d+$/, // Jira key
  /^chamado\s+\d+$/,
  /^#\d+$/,
  /^\d+$/,
  /http/,
];

const BUSCAR_PATTERN =new RegExp(`^${BUSCAR_COMMAND}\\s+(.+)$`);

/**
 * `text` (NFC, so composed accents are one code unit) with its normalized twin plus, for every
 * normalized character, the index in `text` it came from. Folding one code point at a time makes
 * the mapping exact even when normalization changes the length (decomposed input, stray marks),
 * so a pattern match on `folded` can be turned back into a slice of the original.
 */
function foldWithOffsets(text: string): { original: string; folded: string; offsets: number[] } {
  const original = text.normalize('NFC');
  let folded = '';
  const offsets: number[] = [];
  let index = 0;
  for (const codePoint of original) {
    const piece = normalizeText(codePoint);
    for (let i = 0; i < piece.length; i++) offsets.push(index);
    folded += piece;
    index += codePoint.length;
  }
  return { original, folded, offsets };
}

/** The original-text tail starting at folded index `from`, capped and trimmed. */
function nameFrom(fold: ReturnType<typeof foldWithOffsets>, from: number): string {
  if (from >= fold.folded.length) return '';
  return fold.original.slice(fold.offsets[from]).trim().slice(0, MAX_NAME_LENGTH).trim();
}

/**
 * Deterministic detector for vague portfolio questions. Reachable ONLY where the pipeline would
 * otherwise send the help text (spec §3), so a false positive costs one failed search and a
 * false negative costs the help text the user would have gotten anyway.
 */
export function detectPortfolioQuery(text: string): PortfolioQuery | null {
  const fold = foldWithOffsets(text.normalize('NFC').trim().replace(/[?!.]+$/, '').trim());
  if (fold.folded === '') return null;

  // Singular anchors win: "os cards da obra X" is about the obra.
  const singular = NAME_AFTER_KIND.exec(fold.folded);
  const anchored = singular ?? NAME_AFTER_PLURAL.exec(fold.folded);
  // The loose bare-name shapes run only when no anchored pattern found anything (spec §10.4).
  const loose = anchored ? null : firstMatch(LOOSE_SHAPES, fold.folded);
  const m = anchored ?? loose;
  if (!m) return null;
  const tail = m[1];
  const connectiveLength = anchored ? CONNECTIVE.exec(tail)![0].length : 0;
  const nameStart = m.index + m[0].length - tail.length + connectiveLength;
  const name = nameFrom(fold, nameStart);
  if (name === '') return null;

  // Reject if the name starts with a stop word (e.g., "atrasou muito" → reject).
  const normalizedName = normalizeText(name);
  const firstWord = normalizedName.split(/\s+/)[0];
  if (STOP_NAMES.has(firstWord)) return null;
  // A loose shape must not swallow a question about one specific card.
  if (loose && REFERENCE_SHAPED.some((shape) => shape.test(normalizedName))) return null;

  return { name, mode: singular && CARD_SHAPE.test(fold.folded) ? 'candidates' : 'rundown' };
}

function firstMatch(patterns: readonly RegExp[], text: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return m;
  }
  return null;
}

/** `buscar <nome>` → the name as typed; anything else → null. */
export function parseBuscar(text: string): string | null {
  const fold = foldWithOffsets(text.trim());
  const m = BUSCAR_PATTERN.exec(fold.folded);
  if (!m) return null;
  return nameFrom(fold, m.index + m[0].length - m[1].length) || null;
}

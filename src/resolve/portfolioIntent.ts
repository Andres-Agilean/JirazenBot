import { normalizeText } from '@/text/normalize.js';

/** Explicit search command: works anytime, including with a card bound (spec §3). */
export const BUSCAR_COMMAND = 'buscar';

export interface PortfolioQuery {
  /** Normalized (lowercased, de-accented) name to search for. */
  name: string;
  /** 'candidates' when the phrasing asks about ONE thing; 'rundown' for an overview. */
  mode: 'rundown' | 'candidates';
}

const MAX_NAME_LENGTH = 60;

/** The entity words that anchor a vague query (spec §4: empresa/cliente via Zendesk, obra/projeto via Jira text). */
const KIND = /(?:empresa|cliente|obra|projeto)/;
/** Words that mark the question as being about one card, not a portfolio (spec §5). */
const CARD_SHAPE = /\b(?:problema|erro|bug|card|chamado|ticket|incidente)\b/;
/** Leading connectives between the kind word and the name. */
const CONNECTIVE = /^(?:d[aeo]s?\s+)?/;
/** Names that are almost certainly a verb/stray word, not an entity (false-positive guard). */
const STOP_NAMES = new Set(['atrasou', 'atrasada', 'parou', 'parada', 'anda', 'esta', 'estao']);

const NAME_AFTER_KIND = new RegExp(`${KIND.source}\\s+(.+)$`);

/**
 * Deterministic detector for vague portfolio questions. Reachable ONLY where the pipeline would
 * otherwise send the help text (spec §3), so a false positive costs one failed search and a
 * false negative costs the help text the user would have gotten anyway.
 */
export function detectPortfolioQuery(text: string): PortfolioQuery | null {
  const normalized = normalizeText(text).trim().replace(/[?!.]+$/, '');
  if (normalized === '') return null;

  const m = NAME_AFTER_KIND.exec(normalized);
  if (!m) return null;
  const name = m[1].replace(CONNECTIVE, '').trim().slice(0, MAX_NAME_LENGTH);
  if (name === '') return null;

  // Reject if the name starts with a stop word (e.g., "atrasou muito" → reject).
  const firstWord = name.split(/\s+/)[0];
  if (STOP_NAMES.has(firstWord)) return null;

  return { name, mode: CARD_SHAPE.test(normalized) ? 'candidates' : 'rundown' };
}

/** `buscar <nome>` → the normalized name; anything else → null. */
export function parseBuscar(text: string): string | null {
  const normalized = normalizeText(text).trim();
  const m = new RegExp(`^${BUSCAR_COMMAND}\\s+(.+)$`).exec(normalized);
  if (!m) return null;
  return m[1].trim().slice(0, MAX_NAME_LENGTH) || null;
}

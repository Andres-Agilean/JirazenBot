import type { CardRef } from '../src/resolve/types.js';
import { parseReference } from '../src/resolve/parseReference.js';

export interface SplitRef {
  ref: CardRef;
  question: string;
}

/**
 * parseCardArgs joins every non-flag CLI argument into a single refText, so the boundary between
 * the reference and the trailing quoted question (ask.ts's second argument) is lost. Recover it
 * by growing the leading word-run one word at a time and stopping at the first prefix
 * parseReference accepts ("QZ-252" is one word, "chamado 16467" is two).
 *
 * Growing from the SHORTEST prefix up matters: parseReference's patterns are mostly unanchored
 * (KEYWORD_TICKET, ISSUE_KEY, the URL patterns) and match a reference anywhere inside the text
 * they're given, not only when the whole text equals the reference. Checked longest-first, the
 * full refText (reference + question, already space-joined) would match on the very first try --
 * the reference substring is still present inside it -- leaving no words for the question. Only
 * WHOLE_MESSAGE_NUMBER is anchored, and that case is a single word (ref word count 1) either way,
 * so the ascending order never mis-splits it.
 */
export function splitReferenceAndQuestion(
  refText: string,
  allowedProjects: string[],
): SplitRef | null {
  const words = refText.trim().split(/\s+/);
  let ref: CardRef | null = null;
  let refWordCount = 0;
  for (let n = 1; n <= words.length; n++) {
    const candidate = parseReference(words.slice(0, n).join(' '), allowedProjects);
    if (candidate) {
      ref = candidate;
      refWordCount = n;
      break;
    }
  }
  if (!ref) return null;

  const question = words.slice(refWordCount).join(' ').trim();
  if (question === '') return null;

  return { ref, question };
}

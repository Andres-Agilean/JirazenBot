import type { CardRef } from '@/resolve/types.js';
import { parseReference } from '@/resolve/parseReference.js';

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

/**
 * True only when the ENTIRE message is a reference -- "addressed to the room" in the shared/
 * personal split model (spec §4), as opposed to a reference that merely appears somewhere inside
 * a longer question. `splitReferenceAndQuestion` cannot answer this: it only recognizes a
 * reference that is a PREFIX of the message, so "qual o status do AGL-900?" (reference at the
 * end, not the start) reports no split even though it plainly is not addressed to the room.
 *
 * Implementation: tokenize on whitespace and look for the shortest contiguous run of tokens that
 * `parseReference` accepts, scanning by ascending run length. A run shorter than the whole message
 * counts only if the match is EXPLICIT: `parseReference`'s WHOLE_MESSAGE_NUMBER pattern is anchored
 * to its own input, so handing it an isolated digit token in isolation (e.g. the "16467" inside
 * "chamado 16467") trivially "matches" that token alone -- which says nothing about whether the
 * two-word "chamado 16467" is itself the whole message. Only an explicit match is allowed to
 * settle the search early; an implicit match is accepted only once the run already covers every
 * token, i.e. the whole message already reduces to nothing else.
 */
export function isWholeMessageReference(text: string, allowedProjects: string[]): boolean {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return false;

  for (let len = 1; len <= words.length; len++) {
    for (let start = 0; start + len <= words.length; start++) {
      const candidate = words.slice(start, start + len).join(' ');
      const parsed = parseReference(candidate, allowedProjects);
      if (!parsed) continue;
      if (!parsed.explicit && len < words.length) continue;
      return len === words.length;
    }
  }
  return false;
}

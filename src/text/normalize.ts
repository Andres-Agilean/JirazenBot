/**
 * Lowercase and strip diacritics. Shared by command parsing and the grounding eval rules so
 * "Ajuda"/"ajuda"/"AJUDA" and "André"/"andre" compare equal in both places from one definition.
 */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

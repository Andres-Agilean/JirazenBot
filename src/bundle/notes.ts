// pt-BR disclosure/truncation strings shown in a rendered bundle. Centralized so a note's
// wording is defined once and both the producer (assemble.ts / budget.ts) and the tests that
// assert on it stay in sync -- instead of the same sentence being retyped as a literal in
// multiple places, which can silently drift.

export type Side = 'Jira' | 'Zendesk';

/** Shown when the resolver found a counterpart reference but fetching it failed. */
export function counterpartUnreadableNote(side: Side, label: string): string {
  return `contraparte ${side} ${label} foi encontrada mas não pôde ser carregada`;
}

/** Shown when a comment page came back at the API's page-size limit, so older comments exist but weren't fetched. */
export function olderCommentsOmittedNote(side: Side, pageSize: number): string {
  return `comentários mais antigos do ${side} não foram carregados (limite de ${pageSize})`;
}

// Current field values, the 10 most recent comments per side, and resolution metadata are never
// truncated (spec), so a single huge comment or ADF field can still leave the bundle over budget
// after every truncation step in budget.ts runs. This must stay visible in the rendered bundle
// rather than fail silently.
export const BUDGET_EXCEEDED_NOTE = 'orçamento de tokens excedido após truncamento';

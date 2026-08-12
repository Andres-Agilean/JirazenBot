import { renderBundle } from './render.js';
import type { CardBundle } from './types.js';

const MAX_BODY = 1500;
const KEEP_RECENT = 10;
const KEEP_HISTORY = 20;
// Jira comment bodies are never shortened (step 1 is Zendesk-only) and current field values /
// the 10 most recent comments per side are never truncated (spec), so a single huge Jira
// comment or ADF description can still leave the bundle over budget after all three steps.
// This must stay visible in the rendered bundle rather than fail silently.
const BUDGET_EXCEEDED_NOTE = 'orçamento de tokens excedido após truncamento';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function applyBudget(bundle: CardBundle, budgetTokens: number): CardBundle {
  const b: CardBundle = structuredClone(bundle);
  if (fits(b, budgetTokens)) return b;

  // Passo 1: encurta corpos longos de comentários Zendesk (exceto os 10 mais recentes)
  if (b.zendesk) {
    const cutoff = b.zendesk.comments.length - KEEP_RECENT;
    let shortened = 0;
    b.zendesk.comments = b.zendesk.comments.map((c, i) => {
      if (i < cutoff && c.body.length > MAX_BODY) {
        shortened++;
        return { ...c, body: `${c.body.slice(0, MAX_BODY)}… [truncado]` };
      }
      return c;
    });
    if (shortened > 0) b.truncationNotes.push(`${shortened} comentários do Zendesk foram encurtados`);
  }
  if (fits(b, budgetTokens)) return b;

  // Passo 2: descarta comentários do meio (mantém o primeiro + 10 mais recentes), Zendesk primeiro
  for (const side of ['zendesk', 'jira'] as const) {
    const s = b[side];
    if (!s) continue;
    while (!fits(b, budgetTokens) && s.comments.length > 1 + KEEP_RECENT) {
      s.comments.splice(1, 1); // remove o mais antigo depois do primeiro
    }
    const originalLength = side === 'zendesk' ? bundle.zendesk!.comments.length : bundle.jira!.comments.length;
    if (s.comments.length < originalLength) {
      b.truncationNotes.push(`comentários intermediários do ${side === 'zendesk' ? 'Zendesk' : 'Jira'} foram omitidos`);
    }
  }
  if (fits(b, budgetTokens)) return b;

  // Passo 3: limita o histórico às 20 transições mais recentes
  if (b.jira && b.jira.statusHistory.length > KEEP_HISTORY) {
    b.jira.statusHistory = b.jira.statusHistory.slice(-KEEP_HISTORY);
    b.truncationNotes.push('histórico de status antigo foi omitido');
  }
  if (!fits(b, budgetTokens)) {
    b.truncationNotes.push(BUDGET_EXCEEDED_NOTE);
  }
  return b;
}

function fits(b: CardBundle, budget: number): boolean {
  return estimateTokens(renderBundle(b)) <= budget;
}

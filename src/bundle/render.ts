import { adfToMarkdown, type AdfNode } from '../fetch/adf.js';
import { JIRA_FIELD_LABELS } from '../fetch/jira.js';
import { condenseDevelopment, type Transition } from '../fetch/condense.js';
import type { CardBundle } from './types.js';

const RICH_TEXT_FIELDS = new Set(['description', 'customfield_10070', 'customfield_10071', 'customfield_10320', 'customfield_10284']);

export function renderBundle(b: CardBundle): string {
  const parts: string[] = ['<CARD_BUNDLE>', `fetched_at: ${b.fetchedAt}`];

  if (b.jira) {
    parts.push(`\n## Jira: ${b.jira.issueKey}`);
    const scalarLines: string[] = [];
    const richSections: string[] = [];
    for (const [id, label] of Object.entries(JIRA_FIELD_LABELS)) {
      const value = b.jira.fields[id];
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) continue;
      if (RICH_TEXT_FIELDS.has(id)) {
        const md = adfToMarkdown(value as AdfNode | string);
        if (md) richSections.push(`### ${label}\n${md}`);
      } else {
        const rendered = renderFieldValue(id, value);
        if (rendered !== null) scalarLines.push(`- ${label}: ${rendered}`);
      }
    }
    parts.push(scalarLines.join('\n'));
    parts.push(...richSections);

    if (b.jira.statusHistory.length > 0) {
      parts.push(`### Histórico\n${renderHistory(b.jira.statusHistory)}`);
    }
    if (b.jira.comments.length > 0) {
      parts.push('### Comentários (Jira)');
      for (const c of b.jira.comments) {
        parts.push(`[comentário jira ${c.id}] ${c.author} — ${c.createdAt}\n${adfToMarkdown(c.body as AdfNode | string)}`);
      }
    }
  }

  if (b.zendesk) {
    const z = b.zendesk;
    parts.push(`\n## Zendesk: chamado ${z.ticketId}`);
    parts.push([
      `- Assunto: ${z.subject}`,
      `- Status: ${z.status}`,
      z.priority ? `- Prioridade: ${z.priority}` : null,
      `- Criado em: ${z.createdAt}`,
      `- Atualizado em: ${z.updatedAt}`,
    ].filter(Boolean).join('\n'));
    if (z.internalNotesOmitted) parts.push('Notas internas do Zendesk foram omitidas neste contexto.');
    if (z.comments.length > 0) {
      parts.push('### Comentários (Zendesk)');
      for (const c of z.comments) {
        const flag = c.isPublic ? '' : '[NOTA INTERNA] ';
        parts.push(`[comentário zendesk ${c.id}] ${flag}${c.author} — ${c.createdAt}\n${c.body}`);
      }
    }
  }

  parts.push(`\nresolução: via ${b.resolution.via}`);
  if (b.truncationNotes.length > 0) {
    parts.push(`truncamento: ${b.truncationNotes.join('; ')}`);
  }
  parts.push('</CARD_BUNDLE>');
  return parts.filter((p) => p !== '').join('\n\n').replace(/\n{3,}/g, '\n\n');
}

function renderFieldValue(id: string, value: unknown): string | null {
  if (id === 'customfield_10000') return condenseDevelopment(value);
  if (id === 'timetracking') {
    const t = value as { timeSpent?: string; remainingEstimate?: string; originalEstimate?: string };
    const bits = [
      t.originalEstimate ? `estimado ${t.originalEstimate}` : null,
      t.timeSpent ? `gasto ${t.timeSpent}` : null,
      t.remainingEstimate ? `restante ${t.remainingEstimate}` : null,
    ].filter(Boolean);
    return bits.length > 0 ? bits.join(', ') : null;
  }
  if (id === 'aggregatetimespent' && typeof value === 'number') {
    return `${Math.round((value / 3600) * 10) / 10}h`;
  }
  return renderGeneric(value);
}

function renderGeneric(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.map(renderGeneric).filter((v): v is string => v !== null);
    return items.length > 0 ? items.join(', ') : null;
  }
  const o = value as Record<string, unknown>;
  for (const k of ['displayName', 'name', 'value', 'text']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return null; // opaque object — omit rather than dump JSON
}

function renderHistory(transitions: Transition[]): string {
  return transitions.map((t, i) => {
    const date = t.at.slice(0, 10);
    if (t.field === 'assignee') {
      return `- ${date}: responsável ${t.from ?? '—'} → ${t.to ?? '—'} (por ${t.by})`;
    }
    const next = transitions.slice(i + 1).find((n) => n.field === 'status');
    const end = next ? new Date(next.at).getTime() : Date.now();
    const days = Math.round((end - new Date(t.at).getTime()) / 86_400_000);
    const dur = next ? `, ${days}d no estado seguinte` : `, há ${days}d neste estado`;
    return `- ${date}: status ${t.from ?? '—'} → ${t.to ?? '—'} (por ${t.by}${dur})`;
  }).join('\n');
}

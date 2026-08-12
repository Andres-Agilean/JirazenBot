import { adfToMarkdown, type AdfNode } from '../fetch/adf.js';
import { JIRA_FIELD_LABELS, type JiraFieldMeta } from '../fetch/jira.js';
import { condenseDevelopment, type Transition } from '../fetch/condense.js';
import type { CardBundle } from './types.js';

// Envelope markers wrapping the whole rendered bundle -- named so the open/close pair can
// never drift out of sync with each other.
const ENVELOPE_OPEN = '<CARD_BUNDLE>';
const ENVELOPE_CLOSE = '</CARD_BUNDLE>';

export function renderBundle(b: CardBundle): string {
  const parts: string[] = [ENVELOPE_OPEN, `fetched_at: ${b.fetchedAt}`];

  if (b.jira) {
    parts.push(`\n## Jira: ${b.jira.issueKey}`);
    const scalarLines: string[] = [];
    const richSections: string[] = [];
    for (const [id, meta] of Object.entries(JIRA_FIELD_LABELS)) {
      const { label } = meta;
      const value = b.jira.fields[id];
      if (isEmptyFieldValue(value)) continue;
      if (meta.kind === 'issueRef') {
        const rendered = renderParent(value);
        if (rendered !== null) scalarLines.push(`- ${label}: ${rendered}`);
        continue;
      }
      if (meta.kind === 'rich' || isAdfDoc(value)) {
        const md = adfToMarkdown(value as AdfNode | string);
        if (md) richSections.push(`### ${label}\n${md}`);
        continue;
      }
      const rendered = renderFieldValue(meta.kind, id, value);
      if (rendered !== null && rendered !== '') scalarLines.push(`- ${label}: ${rendered}`);
    }
    parts.push(scalarLines.join('\n'));
    parts.push(...richSections);

    if (b.jira.statusHistory.length > 0) {
      parts.push(`### Histórico\n${renderHistory(b.jira.statusHistory, b.fetchedAt)}`);
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
  parts.push(ENVELOPE_CLOSE);
  return parts.filter((p) => p !== '').join('\n\n').replace(/\n{3,}/g, '\n\n');
}

function isEmptyFieldValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function isAdfDoc(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).type === 'doc';
}

function renderParent(value: unknown): string | null {
  const p = value as { key?: string; fields?: { summary?: string } };
  if (typeof p?.key !== 'string' || p.key === '') return null;
  const summary = typeof p.fields?.summary === 'string' && p.fields.summary !== '' ? ` — ${p.fields.summary}` : '';
  return `${p.key}${summary}`;
}

function renderFieldValue(kind: JiraFieldMeta['kind'], id: string, value: unknown): string | null {
  if (kind === 'development') return condenseDevelopment(value);
  if (kind === 'timeTracking') {
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

function renderHistory(transitions: Transition[], fetchedAt: string): string {
  return transitions.map((t, i) => {
    // Derive the printed date from the same UTC instant the duration math below uses
    // (new Date(t.at).getTime()), not from slicing the raw timestamp string -- the raw
    // string encodes the API's local offset, so slicing it prints a wall-clock date that
    // can disagree with the UTC-based duration on a late-evening transition.
    const date = new Date(t.at).toISOString().slice(0, 10);
    if (t.field === 'assignee') {
      return `- ${date}: responsável ${t.from ?? '—'} → ${t.to ?? '—'} (por ${t.by})`;
    }
    const next = transitions.slice(i + 1).find((n) => n.field === 'status');
    const end = next ? new Date(next.at).getTime() : new Date(fetchedAt).getTime();
    const days = Math.round((end - new Date(t.at).getTime()) / 86_400_000);
    const dur = next ? `, ${days}d no estado seguinte` : `, há ${days}d neste estado`;
    return `- ${date}: status ${t.from ?? '—'} → ${t.to ?? '—'} (por ${t.by}${dur})`;
  }).join('\n');
}

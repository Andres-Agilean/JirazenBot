export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

// Shared wording for an unrenderable attachment placeholder, so Jira ADF media nodes here and
// Zendesk-mirrored Jira wiki-markup image macros (fetch/wikiToMarkdown.ts) render identical text
// instead of two hand-typed literals that could drift apart. A media node's `id` is a
// media-services UUID that does not match any Jira attachment id (verified live: ADF media ids
// like "33333333-..." never match the `attachment` field's numeric ids) -- it is not a
// meaningful token for an LLM grounding context and is pure noise at best, easily misread as
// real data at worst, so it must never be emitted, not even as a fallback.
export function attachmentPlaceholder(filename?: string | null): string {
  return filename ? `[anexo: ${filename}]` : '[anexo]';
}

export function adfToMarkdown(node: AdfNode | string | null | undefined): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return renderBlocks(node.type === 'doc' ? node.content ?? [] : [node]).trim();
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes.map(renderBlock).filter((s) => s !== '').join('\n\n');
}

function renderBlock(n: AdfNode): string {
  switch (n.type) {
    case 'paragraph':
      return renderInline(n.content ?? []);
    case 'heading':
      return `${'#'.repeat(Number(n.attrs?.level ?? 1))} ${renderInline(n.content ?? [])}`;
    case 'codeBlock': {
      const lang = typeof n.attrs?.language === 'string' ? n.attrs.language : '';
      return `\`\`\`${lang}\n${(n.content ?? []).map((c) => c.text ?? '').join('')}\n\`\`\``;
    }
    case 'blockquote':
      return renderBlocks(n.content ?? []).split('\n').map((l) => `> ${l}`).join('\n');
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${renderListItem(li)}`).join('\n');
    case 'orderedList':
      return (n.content ?? []).map((li, i) => `${i + 1}. ${renderListItem(li)}`).join('\n');
    case 'table':
      return renderTable(n);
    case 'rule':
      return '---';
    case 'mediaGroup':
    case 'mediaSingle':
      return (n.content ?? []).map(renderBlock).join('\n');
    case 'media': {
      const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt : null;
      return attachmentPlaceholder(alt);
    }
    case 'panel':
    default: {
      // panels, layout containers and unknown/unhandled blocks (incl. taskList/taskItem):
      // keep children, drop the wrapper. Some of these (e.g. taskItem) hold inline content
      // directly rather than wrapping it in a paragraph, so route inline children through
      // renderInline -- otherwise renderBlock has no 'text' case and silently drops them.
      if (!n.content) return '';
      return n.content.some(isInlineNode) ? renderInline(n.content) : renderBlocks(n.content);
    }
  }
}

const INLINE_TYPES = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date']);

function isInlineNode(n: AdfNode): boolean {
  return INLINE_TYPES.has(n.type);
}

function renderListItem(li: AdfNode): string {
  const blocks = (li.content ?? []).map(renderBlock).filter((s) => s !== '');
  const [first = '', ...rest] = blocks;
  if (rest.length === 0) return first;
  const indented = rest
    .map((b) => b.split('\n').map((l) => `  ${l}`).join('\n'))
    .join('\n');
  return `${first}\n${indented}`;
}

function renderTable(table: AdfNode): string {
  const rows = (table.content ?? []).filter((r) => r.type === 'tableRow');
  if (rows.length === 0) return '';
  const cells = (r: AdfNode) => (r.content ?? []).map((c) => renderBlocks(c.content ?? []).replace(/\n/g, ' '));
  const lines = rows.map((r) => `| ${cells(r).join(' | ')} |`);
  const width = cells(rows[0]).length;
  lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return lines.join('\n');
}

function renderInline(nodes: AdfNode[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return applyMarks(n.text ?? '', n.marks ?? []);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(n.attrs?.text ?? '@?');
    case 'emoji':
      return String(n.attrs?.shortName ?? '');
    case 'inlineCard':
      return String(n.attrs?.url ?? '');
    case 'status':
      return `[${String(n.attrs?.text ?? '')}]`;
    case 'date':
      return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
    default:
      return n.content ? renderInline(n.content) : '';
  }
}

function applyMarks(text: string, marks: NonNullable<AdfNode['marks']>): string {
  let out = text;
  for (const m of marks) {
    if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'em') out = `*${out}*`;
    else if (m.type === 'code') out = `\`${out}\``;
    else if (m.type === 'strike') out = `~~${out}~~`;
    else if (m.type === 'link') out = `[${out}](${String(m.attrs?.href ?? '')})`;
  }
  return out;
}

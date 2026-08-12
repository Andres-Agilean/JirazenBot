import { attachmentPlaceholder } from './adf.js';

// Converts Jira wiki markup to markdown for Zendesk comment bodies. This tenant's Jira<->Zendesk
// integration mirrors Jira comments into Zendesk as internal notes carrying raw wiki markup --
// verified live on ticket 16467/QZ-252 (see fetch/jiraMirror.ts). Zendesk's comment bodies are
// plain text/lightly-formatted markdown by default and never pass through the ADF converter
// (fetch/adf.ts), so this markup would otherwise reach an LLM's grounding context unconverted.
//
// Structured the same way as adf.ts: one exported entry point, private per-construct helpers.
// Only handles constructs verified live on this tenant (see the design addendum finding); text
// that uses none of them -- the common case -- passes through byte-identical.

/** Strips a `{name[:attrs]}` ... `{name}` wrapper, keeping its inner content as-is. */
function stripBlockMacro(text: string, name: string): string {
  const re = new RegExp(`\\{${name}(?::[^}]*)?\\}\\n?([\\s\\S]*?)\\n?\\{${name}\\}`, 'g');
  return text.replace(re, (_m, inner: string) => inner);
}

/** `{quote}` ... `{quote}` becomes markdown blockquote lines, mirroring adf.ts's blockquote rendering. */
function convertQuote(text: string): string {
  const re = /\{quote\}\n?([\s\S]*?)\n?\{quote\}/g;
  return text.replace(re, (_m, inner: string) => inner.split('\n').map((line) => `> ${line}`).join('\n'));
}

/** `{code[:lang]}` ... `{code}` becomes a fenced code block. */
function convertCodeBlocks(text: string): string {
  const re = /\{code(?::([^}\n]*))?\}\n?([\s\S]*?)\n?\{code\}/g;
  return text.replace(re, (_m, lang: string | undefined, inner: string) => `\`\`\`${lang ?? ''}\n${inner}\n\`\`\``);
}

// The duplicated-url smart-link form Jira emits for pasted links: `[url|url|smart-link]`. Collapse
// to the bare url rather than `[url](url)` -- writing the url twice would double a token an LLM
// grounding context gets no extra information from repeating.
const SMART_LINK_RE = /\[([^|\]]+)\|\1\|smart-link\]/g;
function convertSmartLinks(text: string): string {
  return text.replace(SMART_LINK_RE, '$1');
}

/** Ordinary `[text|url]` becomes a markdown link. Runs after convertSmartLinks so that form is already gone. */
const LINK_RE = /\[([^|\]]+)\|([^|\]]+)\]/g;
function convertLinks(text: string): string {
  return text.replace(LINK_RE, '[$1]($2)');
}

// `!filename.png|width=579,alt="..."!` (optionally with no `|attrs`). The filename is the only
// part worth keeping -- width/alt/etc. are rendering hints, not facts about the ticket.
const MEDIA_RE = /!([^!|\s]+)(?:\|[^!]*)?!/g;
function convertMedia(text: string): string {
  return text.replace(MEDIA_RE, (_m, filename: string) => attachmentPlaceholder(filename));
}

/** `{{monospace}}` becomes backticked code. */
const MONOSPACE_RE = /\{\{([^{}]+)\}\}/g;
function convertMonospace(text: string): string {
  return text.replace(MONOSPACE_RE, '`$1`');
}

/** `h1.`-`h6.` at the start of a line becomes a markdown heading of the same level. */
const HEADING_RE = /^h([1-6])\.\s*/gm;
function convertHeadings(text: string): string {
  return text.replace(HEADING_RE, (_m, level: string) => `${'#'.repeat(Number(level))} `);
}

export function wikiToMarkdown(body: string): string {
  let out = body;
  out = convertCodeBlocks(out);
  out = stripBlockMacro(out, 'panel');
  out = stripBlockMacro(out, 'color');
  out = stripBlockMacro(out, 'noformat');
  out = convertQuote(out);
  out = convertSmartLinks(out);
  out = convertLinks(out);
  out = convertMedia(out);
  out = convertMonospace(out);
  out = convertHeadings(out);
  return out;
}

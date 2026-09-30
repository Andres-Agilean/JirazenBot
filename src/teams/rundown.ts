import type { Config } from '@/config.js';
import { CARD_FETCH_CAP, type ZendeskOrg } from '@/fetch/zendesk.js';
import { DAY_MS, formatDayMonthTime } from '@/text/datetime.js';
import { normalizeText } from '@/text/normalize.js';
import { ADAPTIVE_CARD_SCHEMA, ADAPTIVE_CARD_VERSION, styleCitations } from './cards.js';
import { assigneeBuckets, statusBuckets, type Bucket, type DistributionDimension } from './grouping.js';
import { collectedTime, jiraLink, zendeskLink } from './reply.js';
import { candidateId, type CardCandidate } from './search.js';

/** Most card lines a rundown shows PER SECTION (a two-section card is bounded at twice this); the rest collapse into that section's overflow line. */
export const SECTION_LINE_CAP = 5;
/** Most selection buttons a candidate card shows; the rest are reachable by typing a name. */
export const BUTTON_CAP = 6;
/** A card untouched for longer than this is called out as the stalest one. */
export const STALE_AFTER_DAYS = 14;
/** Most labels a section's overflow line names before trailing off with an ellipsis. */
export const OVERFLOW_LABEL_CAP = 10;
/**
 * Action.Execute verb for picking a candidate. Unlike `REFRESH_ACTION` there is no typed command
 * twin to derive it from: typed selection goes through `matchCandidate`, not `parseCommand`.
 */
export const SELECT_ACTION = 'selecionar';

/** `DD/MM` in Brazil local time, from the shared datetime formatter (no inline timezone logic). */
export const dayMonth = (iso: string): string => formatDayMonthTime(iso).split(' ')[0];

/** A candidate's own key as a markdown link: `[QZ-306](jira url)` / `[chamado 17044](zendesk url)`. */
const keyLink = (c: CardCandidate, cfg: Config): string =>
  `[${c.label}](${c.ref.system === 'jira' ? jiraLink(c.ref.issueKey, cfg) : zendeskLink(c.ref.ticketId, cfg)})`;

/** The key, plus ` ↔ [chamado N](url)` when a Jira candidate's Zendesk pair is known (spec §10.4). */
function keyMarkup(c: CardCandidate, cfg: Config): string {
  if (!c.zendeskId) return keyLink(c, cfg);
  return `${keyLink(c, cfg)} ↔ [chamado ${c.zendeskId}](${zendeskLink(c.zendeskId, cfg)})`;
}

const cardLine = (c: CardCandidate, cfg: Config): string =>
  `${keyMarkup(c, cfg)} — ${c.summary} — ${c.status}, atualizado ${dayMonth(c.updatedAt)}`;

/** Section order and titles: Jira cards first, then Zendesk tickets that have no Jira card. */
const SECTIONS = [
  { title: 'Cards (Jira)', system: 'jira' },
  { title: 'Chamados (Zendesk)', system: 'zendesk' },
] as const;

/** Which section(s) a follow-up expansion shows in full: one system, or both. */
export type ExpandSection = 'jira' | 'zendesk' | 'all';

interface RenderedSection {
  title: string;
  shown: CardCandidate[];
  hidden: CardCandidate[];
}

/**
 * Splits into the non-empty sections (incoming newest-first order kept inside each) and shows
 * at most `cap` lines PER SECTION, so a two-section card is bounded at twice the cap; what does
 * not fit is that section's `hidden` list. No cap shows everything.
 */
function sectioned(cards: CardCandidate[], cap = Infinity, uncap?: ExpandSection): RenderedSection[] {
  return SECTIONS
    .map((s) => ({ title: s.title, system: s.system, all: cards.filter((c) => c.ref.system === s.system) }))
    .filter((s) => s.all.length > 0)
    .map((s) => {
      const limit = uncap === 'all' || uncap === s.system ? Infinity : cap;
      return { title: s.title, shown: s.all.slice(0, limit), hidden: s.all.slice(limit) };
    });
}

/** `e mais N: [A](url), [B](url), …` -- names a section's hidden items so each is reachable by typing. */
function overflowLine(hidden: CardCandidate[], cfg: Config): string | undefined {
  if (hidden.length === 0) return undefined;
  const listed = hidden.slice(0, OVERFLOW_LABEL_CAP).map((c) => keyLink(c, cfg)).join(', ');
  return `e mais ${hidden.length}: ${listed}${hidden.length > OVERFLOW_LABEL_CAP ? ', …' : ''}`;
}

/** Statuses (normalized) that read as finished. Tenant-tunable. */
const GOOD_STATUSES = new Set(['done', 'pronto para producao', 'resolvido', 'closed', 'solved']);
/** Substrings (normalized) that mark a status as needing attention. Tenant-tunable. */
const ATTENTION_MARKERS = ['bloqueado', 'blocked', 'reprovado'];

export type StatusColor = 'good' | 'attention' | 'default';

/** Adaptive Card TextBlock color for a Jira/Zendesk status (spec §10.2). */
export function statusColor(status: string): StatusColor {
  const s = normalizeText(status).trim();
  if (GOOD_STATUSES.has(s)) return 'good';
  if (ATTENTION_MARKERS.some((m) => s.includes(m))) return 'attention';
  return 'default';
}

const subtle = (text: string): Record<string, unknown> => ({ type: 'TextBlock', text, wrap: true, isSubtle: true });

/** The two TextBlocks of one card line: bold linked key + summary, then a subtle colored status line. */
function cardBlocks(c: CardCandidate, cfg: Config): Record<string, unknown>[] {
  const detail = [c.status, c.assignee, `atualizado ${dayMonth(c.updatedAt)}`].filter(Boolean).join(' · ');
  return [
    { type: 'TextBlock', text: `**${keyMarkup(c, cfg)}** — ${c.summary}`, wrap: true, spacing: 'Small' },
    { type: 'TextBlock', text: detail, wrap: true, isSubtle: true, color: statusColor(c.status), spacing: 'None' },
  ];
}

/** A section's bold, separated header block. */
const sectionHeader = (title: string): Record<string, unknown> => (
  { type: 'TextBlock', text: title, wrap: true, weight: 'Bolder', separator: true, spacing: 'Medium' }
);

/**
 * Card body blocks per section: bold separated header, its lines, then its footer (overflow, then
 * stale). `nowMs` undefined leaves the stale line out (the candidate card never had one).
 */
const sectionBlocks = (sections: RenderedSection[], cfg: Config, nowMs?: number): Record<string, unknown>[] =>
  sections.flatMap((s) => [
    sectionHeader(s.title),
    ...s.shown.flatMap((c) => cardBlocks(c, cfg)),
    ...sectionFooter(s, cfg, nowMs).map(subtle),
  ]);

/** The card title: the matched name and count, prominent (never subtle). */
const titleBlock = (name: string, total: number): Record<string, unknown> => (
  { type: 'TextBlock', text: `${name} — ${countLabel(total)}`, wrap: true, weight: 'Bolder', size: 'Large' }
);

const adaptiveCard = (body: Record<string, unknown>[]): Record<string, unknown> => ({
  $schema: ADAPTIVE_CARD_SCHEMA,
  type: 'AdaptiveCard',
  version: ADAPTIVE_CARD_VERSION,
  body,
});

const updatedAtMs = (c: CardCandidate): number => Date.parse(c.updatedAt);

/**
 * Candidates with a parseable `updatedAt`, oldest first (a missing date is not "oldest"; ties keep
 * incoming order). Shared by the rundown's stalest line and the portfolio aggregates.
 */
export const datedOldestFirst = (cards: CardCandidate[]): CardCandidate[] =>
  cards.filter((c) => !Number.isNaN(updatedAtMs(c))).sort((a, b) => updatedAtMs(a) - updatedAtMs(b));

/** True when the candidate went untouched for longer than `STALE_AFTER_DAYS` as of `nowMs`. */
export const isStale = (c: CardCandidate, nowMs: number): boolean => nowMs - updatedAtMs(c) > STALE_AFTER_DAYS * DAY_MS;

/** The candidate with the oldest parseable `updatedAt`, if it is past the stale threshold. */
function staleCard(cards: CardCandidate[], nowMs: number): CardCandidate | undefined {
  const oldest = datedOldestFirst(cards)[0];
  return oldest && isStale(oldest, nowMs) ? oldest : undefined;
}

/**
 * A section's foot lines, shared by the text and the card: its overflow line, then its stale line.
 * The stale item is picked over the section's FULL list (shown + hidden). No `nowMs`: no stale line.
 */
function sectionFooter(s: RenderedSection, cfg: Config, nowMs?: number): string[] {
  const lines: string[] = [];
  const overflow = overflowLine(s.hidden, cfg);
  if (overflow) lines.push(overflow);
  const stale = nowMs === undefined ? undefined : staleCard([...s.shown, ...s.hidden], nowMs);
  if (stale) {
    lines.push(`parado há mais tempo: ${keyLink(stale, cfg)}, sem atualização desde ${dayMonth(stale.updatedAt)}`);
  }
  return lines;
}

/**
 * "N atividades abertas", except once the pre-cap total reaches the fetch cap: then more may
 * exist that were never fetched, so an exact count would be a false claim.
 */
const countLabel = (total: number): string =>
  total >= CARD_FETCH_CAP
    ? `${CARD_FETCH_CAP}+ atividades abertas (mostrando as mais recentes)`
    : `${total} atividades abertas`;

/** The plain-text header of a rundown-family answer: bold name, count and collection time. */
const headerLine = (name: string, total: number, collectedAtMs: number): string =>
  `**${name} — ${countLabel(total)} (coletado às ${collectedTime(collectedAtMs)})**`;

/** The card header pair shared by every rundown-family card: prominent title, subtle collection time. */
const cardFrame = (
  name: string,
  total: number,
  collectedAtMs: number,
  content: Record<string, unknown>[],
): Record<string, unknown> => adaptiveCard([
  titleBlock(name, total),
  ...content,
  subtle(`coletado às ${collectedTime(collectedAtMs)}`),
]);

/** Deterministic text rundown of an organization's active cards. Every value is verbatim. */
export function renderRundown(
  name: string,
  cards: CardCandidate[],
  total: number,
  collectedAtMs: number,
  cfg: Config,
  uncap?: ExpandSection,
): string {
  const lines = [headerLine(name, total, collectedAtMs)];
  for (const s of sectioned(cards, SECTION_LINE_CAP, uncap)) {
    lines.push(s.title, ...s.shown.map((c) => `- ${cardLine(c, cfg)}`), ...sectionFooter(s, cfg, collectedAtMs));
  }
  return lines.join('\n');
}

/** The rundown as an Adaptive Card: same content as `renderRundown`, no buttons (it never binds). */
export function buildRundownCard(
  name: string,
  cards: CardCandidate[],
  total: number,
  collectedAtMs: number,
  cfg: Config,
  uncap?: ExpandSection,
): Record<string, unknown> {
  return cardFrame(name, total, collectedAtMs, sectionBlocks(sectioned(cards, SECTION_LINE_CAP, uncap), cfg, collectedAtMs));
}

/** One distribution line: `**<bucket> — N:**` then up to SECTION_LINE_CAP bold key links, then a plain `e mais N`. */
function bucketLine(bucket: Bucket, cfg: Config): string {
  const shown = bucket.items.slice(0, SECTION_LINE_CAP).map((c) => `**${keyLink(c, cfg)}**`).join(', ');
  const hidden = bucket.items.length - SECTION_LINE_CAP;
  return `**${bucket.key} — ${bucket.items.length}:** ${shown}${hidden > 0 ? ` e mais ${hidden}` : ''}`;
}

/** A distribution's parts: status gives titled per-system bucket lists, assignee one untitled list. */
interface DistributionPart {
  title?: string;
  buckets: Bucket[];
}

function distributionParts(cards: CardCandidate[], dimension: DistributionDimension): DistributionPart[] {
  if (dimension === 'assignee') return [{ buckets: assigneeBuckets(cards) }];
  return SECTIONS
    .map((s) => ({ title: s.title, buckets: statusBuckets(cards, s.system) }))
    .filter((p) => p.buckets.length > 0);
}

/** Plain-text mirror of `buildDistributionCard`. */
export function renderDistribution(
  name: string,
  cards: CardCandidate[],
  dimension: DistributionDimension,
  total: number,
  collectedAtMs: number,
  cfg: Config,
): string {
  const lines = [headerLine(name, total, collectedAtMs)];
  for (const p of distributionParts(cards, dimension)) {
    if (p.title) lines.push(p.title);
    lines.push(...p.buckets.map((b) => `- ${bucketLine(b, cfg)}`));
  }
  return lines.join('\n');
}

/**
 * The portfolio distributed by status or assignee, as a rundown-family card. Status buckets are
 * colored like the rundown's status lines; assignee buckets stay default. Counts come from the
 * same grouping the `[estatísticas]` aggregates use, so they cannot drift.
 */
export function buildDistributionCard(
  name: string,
  cards: CardCandidate[],
  dimension: DistributionDimension,
  total: number,
  collectedAtMs: number,
  cfg: Config,
): Record<string, unknown> {
  const body = distributionParts(cards, dimension).flatMap((p) => [
    ...(p.title ? [sectionHeader(p.title)] : []),
    ...p.buckets.map((b) => ({
      type: 'TextBlock',
      text: bucketLine(b, cfg),
      wrap: true,
      spacing: 'Small',
      ...(dimension === 'status' ? { color: statusColor(b.key) } : {}),
    })),
  ]);
  return cardFrame(name, total, collectedAtMs, body);
}

/** The line under a portfolio answer: which set it speaks about and how fresh the data is. */
export function portfolioFooter(name: string, collectedAtMs: number): string {
  return `— ${name} · coletado às ${collectedTime(collectedAtMs)}`;
}

/** A portfolio answer as a card: bold set name, `coletado às` subtitle, then the styled answer body. */
export function buildPortfolioAnswerCard(
  name: string,
  answerText: string,
  collectedAtMs: number,
): Record<string, unknown> {
  const time = collectedTime(collectedAtMs);
  return adaptiveCard([
    { type: 'TextBlock', text: name, wrap: true, weight: 'Bolder' },
    { ...subtle(`coletado às ${time}`), spacing: 'None' },
    { type: 'TextBlock', text: styleCitations(answerText), wrap: true, separator: true },
  ]);
}

/** Adaptive Card listing candidates with one select button each (plain object, no Teams SDK). */
export function buildCandidateCard(
  name: string,
  cards: CardCandidate[],
  total: number,
  cfg: Config,
): Record<string, unknown> {
  const shown = cards.slice(0, BUTTON_CAP);
  const body: Record<string, unknown>[] = [
    titleBlock(name, total),
    ...sectionBlocks(sectioned(cards), cfg),
  ];
  const hidden = cards.length - shown.length;
  if (hidden > 0) body.push(subtle(`mais ${hidden} sem botão — digite o nome`));
  return {
    ...adaptiveCard(body),
    actions: shown.map((c) => ({
      type: 'Action.Execute',
      title: c.label,
      verb: SELECT_ACTION,
      data: { action: SELECT_ACTION, system: c.ref.system, id: candidateId(c) },
    })),
  };
}

/** Asks the user to pick among several Zendesk organizations matching `name`. */
export function renderOrgChoices(name: string, orgs: ZendeskOrg[]): string {
  const lines = [`Encontrei mais de uma organização para "${name}". Qual delas?`];
  for (const o of orgs) lines.push(`- ${o.name}`);
  // Must round-trip: a bare org name matches neither the detector nor parseBuscar.
  lines.push('Responda `buscar <nome da organização>` para escolher.');
  return lines.join('\n');
}

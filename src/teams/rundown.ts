import type { Config } from '@/config.js';
import { CARD_FETCH_CAP, type ZendeskOrg } from '@/fetch/zendesk.js';
import { formatDayMonthTime } from '@/text/datetime.js';
import { normalizeText } from '@/text/normalize.js';
import { ADAPTIVE_CARD_SCHEMA, ADAPTIVE_CARD_VERSION } from './cards.js';
import { collectedAt, jiraLink, zendeskLink } from './reply.js';
import { candidateId, type CardCandidate } from './search.js';

/** Most card lines a rundown shows, counted across all sections; the rest collapse into per-section overflow lines. */
export const RUNDOWN_LINE_CAP = 8;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** `DD/MM` in Brazil local time, from the shared datetime formatter (no inline timezone logic). */
const dayMonth = (iso: string): string => formatDayMonthTime(iso).split(' ')[0];

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

interface RenderedSection {
  title: string;
  shown: CardCandidate[];
  hidden: CardCandidate[];
}

/**
 * Splits into the non-empty sections (incoming newest-first order kept inside each) and spends
 * `cap` lines across them in section order, Jira first. The cap is on the card's TOTAL lines, not
 * per section, so the message stays bounded whatever the Jira/Zendesk mix; what does not fit is
 * that section's `hidden` list. No cap shows everything.
 */
function sectioned(cards: CardCandidate[], cap = Infinity): RenderedSection[] {
  let room = cap;
  return SECTIONS
    .map((s) => ({ title: s.title, all: cards.filter((c) => c.ref.system === s.system) }))
    .filter((s) => s.all.length > 0)
    .map((s) => {
      const shown = s.all.slice(0, room);
      room -= shown.length;
      return { title: s.title, shown, hidden: s.all.slice(shown.length) };
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

/** Card body blocks per section: bold separated header, its lines, then its own overflow line. */
const sectionBlocks = (sections: RenderedSection[], cfg: Config): Record<string, unknown>[] =>
  sections.flatMap((s) => {
    const overflow = overflowLine(s.hidden, cfg);
    return [
      { type: 'TextBlock', text: s.title, wrap: true, weight: 'Bolder', separator: true, spacing: 'Medium' },
      ...s.shown.flatMap((c) => cardBlocks(c, cfg)),
      ...(overflow ? [subtle(overflow)] : []),
    ];
  });

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

/** The candidate with the oldest parseable `updatedAt`, if it is past the stale threshold. */
function staleCard(cards: CardCandidate[], nowMs: number): CardCandidate | undefined {
  let oldest: { card: CardCandidate; ms: number } | undefined;
  for (const card of cards) {
    const ms = Date.parse(card.updatedAt);
    if (Number.isNaN(ms)) continue;
    if (!oldest || ms < oldest.ms) oldest = { card, ms };
  }
  return oldest && nowMs - oldest.ms > STALE_AFTER_DAYS * DAY_MS ? oldest.card : undefined;
}

/** The card-global stale line (over ALL candidates, shown or not), shared by the text and the card. */
function staleLine(cards: CardCandidate[], nowMs: number, cfg: Config): string | undefined {
  const stale = staleCard(cards, nowMs);
  return stale
    ? `parado há mais tempo: ${keyLink(stale, cfg)}, sem atualização desde ${dayMonth(stale.updatedAt)}`
    : undefined;
}

/**
 * "N atividades abertas", except once the pre-cap total reaches the fetch cap: then more may
 * exist that were never fetched, so an exact count would be a false claim.
 */
const countLabel = (total: number): string =>
  total >= CARD_FETCH_CAP
    ? `${CARD_FETCH_CAP}+ atividades abertas (mostrando as mais recentes)`
    : `${total} atividades abertas`;

/** Deterministic text rundown of an organization's active cards. Every value is verbatim. */
export function renderRundown(
  name: string,
  cards: CardCandidate[],
  total: number,
  collectedAtMs: number,
  cfg: Config,
): string {
  const time = collectedAt({ fetchedAt: new Date(collectedAtMs).toISOString() });
  const lines = [`**${name} — ${countLabel(total)} (coletado às ${time})**`];
  for (const s of sectioned(cards, RUNDOWN_LINE_CAP)) {
    const overflow = overflowLine(s.hidden, cfg);
    lines.push(s.title, ...s.shown.map((c) => `- ${cardLine(c, cfg)}`), ...(overflow ? [overflow] : []));
  }
  const stale = staleLine(cards, collectedAtMs, cfg);
  if (stale) lines.push(stale);
  return lines.join('\n');
}

/** The rundown as an Adaptive Card: same content as `renderRundown`, no buttons (it never binds). */
export function buildRundownCard(
  name: string,
  cards: CardCandidate[],
  total: number,
  collectedAtMs: number,
  cfg: Config,
): Record<string, unknown> {
  const time = collectedAt({ fetchedAt: new Date(collectedAtMs).toISOString() });
  const stale = staleLine(cards, collectedAtMs, cfg);
  return adaptiveCard([
    titleBlock(name, total),
    ...sectionBlocks(sectioned(cards, RUNDOWN_LINE_CAP), cfg),
    ...(stale ? [subtle(stale)] : []),
    subtle(`coletado às ${time}`),
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

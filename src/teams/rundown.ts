import { CARD_FETCH_CAP, type ZendeskOrg } from '@/fetch/zendesk.js';
import { formatDayMonthTime } from '@/text/datetime.js';
import { normalizeText } from '@/text/normalize.js';
import { ADAPTIVE_CARD_SCHEMA, ADAPTIVE_CARD_VERSION } from './cards.js';
import { collectedAt } from './reply.js';
import { candidateId, type CardCandidate } from './search.js';

/** Most card lines a text rundown shows before collapsing the rest into an overflow line. */
export const RUNDOWN_LINE_CAP = 8;
/** Most selection buttons a candidate card shows; the rest are reachable by typing a name. */
export const BUTTON_CAP = 6;
/** A card untouched for longer than this is called out as the stalest one. */
export const STALE_AFTER_DAYS = 14;
/**
 * Action.Execute verb for picking a candidate. Unlike `REFRESH_ACTION` there is no typed command
 * twin to derive it from: typed selection goes through `matchCandidate`, not `parseCommand`.
 */
export const SELECT_ACTION = 'selecionar';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `DD/MM` in Brazil local time, from the shared datetime formatter (no inline timezone logic). */
const dayMonth = (iso: string): string => formatDayMonthTime(iso).split(' ')[0];

/** `↔ chamado N` after a Jira key whose Zendesk pair is known (spec §10.4). */
const pairSuffix = (c: CardCandidate): string => (c.zendeskId ? ` ↔ chamado ${c.zendeskId}` : '');

const cardLine = (c: CardCandidate): string =>
  `${c.label}${pairSuffix(c)} — ${c.summary} — ${c.status}, atualizado ${dayMonth(c.updatedAt)}`;

/** Section order and titles: Jira cards first, then Zendesk tickets that have no Jira card. */
const SECTIONS = [
  { title: 'Cards (Jira)', system: 'jira' },
  { title: 'Chamados (Zendesk)', system: 'zendesk' },
] as const;

/** Splits into the non-empty sections, keeping the incoming (newest-first) order inside each. */
const sectioned = (cards: CardCandidate[]) =>
  SECTIONS.map((s) => ({ title: s.title, cards: cards.filter((c) => c.ref.system === s.system) }))
    .filter((s) => s.cards.length > 0);

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

/** The two TextBlocks of one card line: bold key + summary, then a subtle colored status line. */
function cardBlocks(c: CardCandidate): Record<string, unknown>[] {
  const detail = [c.status, c.assignee, `atualizado ${dayMonth(c.updatedAt)}`].filter(Boolean).join(' · ');
  return [
    { type: 'TextBlock', text: `**${c.label}**${pairSuffix(c)} — ${c.summary}`, wrap: true, spacing: 'Small' },
    { type: 'TextBlock', text: detail, wrap: true, isSubtle: true, color: statusColor(c.status), spacing: 'None' },
  ];
}

/** Card body blocks for `cards`, grouped under bold subtle section headers. */
const sectionBlocks = (cards: CardCandidate[]): Record<string, unknown>[] =>
  sectioned(cards).flatMap((s) => [
    { type: 'TextBlock', text: s.title, wrap: true, weight: 'Bolder', isSubtle: true, spacing: 'Medium' },
    ...s.cards.flatMap(cardBlocks),
  ]);

const subtle = (text: string): Record<string, unknown> => ({ type: 'TextBlock', text, wrap: true, isSubtle: true });

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

/**
 * "N cards ativos", except once the pre-cap total reaches the fetch cap: then more may exist
 * that were never fetched, so an exact count would be a false claim.
 */
const countLabel = (total: number): string =>
  total >= CARD_FETCH_CAP
    ? `${CARD_FETCH_CAP}+ cards ativos (mostrando os mais recentes)`
    : `${total} cards ativos`;

/** Deterministic text rundown of an organization's active cards. Every value is verbatim. */
export function renderRundown(
  name: string,
  cards: CardCandidate[],
  total: number,
  collectedAtMs: number,
): string {
  const time = collectedAt({ fetchedAt: new Date(collectedAtMs).toISOString() });
  const lines = [`**${name} — ${countLabel(total)} (coletado às ${time})**`];
  // The line cap counts cards across ALL sections (newest first), not per section.
  for (const s of sectioned(cards.slice(0, RUNDOWN_LINE_CAP))) {
    lines.push(s.title, ...s.cards.map((c) => `- ${cardLine(c)}`));
  }
  lines.push(...footerLines(cards, total, collectedAtMs));
  return lines.join('\n');
}

/** The overflow and stale lines shared by the text rundown and the rundown card. */
function footerLines(cards: CardCandidate[], total: number, nowMs: number): string[] {
  const lines: string[] = [];
  const hidden = total - Math.min(cards.length, RUNDOWN_LINE_CAP);
  if (hidden > 0) lines.push(`e mais ${hidden} cards — pergunte por um deles`);
  const stale = staleCard(cards, nowMs);
  if (stale) {
    lines.push(`parado há mais tempo: ${stale.label}, sem atualização desde ${dayMonth(stale.updatedAt)}`);
  }
  return lines;
}

/** The rundown as an Adaptive Card: same content as `renderRundown`, no buttons (it never binds). */
export function buildRundownCard(
  name: string,
  cards: CardCandidate[],
  total: number,
  collectedAtMs: number,
): Record<string, unknown> {
  const time = collectedAt({ fetchedAt: new Date(collectedAtMs).toISOString() });
  return adaptiveCard([
    { type: 'TextBlock', text: `${name} — ${countLabel(total)}`, wrap: true, weight: 'Bolder' },
    ...sectionBlocks(cards.slice(0, RUNDOWN_LINE_CAP)),
    ...footerLines(cards, total, collectedAtMs).map(subtle),
    subtle(`coletado às ${time}`),
  ]);
}

/** Adaptive Card listing candidates with one select button each (plain object, no Teams SDK). */
export function buildCandidateCard(
  name: string,
  cards: CardCandidate[],
  total: number,
): Record<string, unknown> {
  const shown = cards.slice(0, BUTTON_CAP);
  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: `${name} — ${countLabel(total)}`, wrap: true, weight: 'Bolder' },
    ...sectionBlocks(cards),
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

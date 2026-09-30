import type { ZendeskOrg } from '@/fetch/zendesk.js';
import { formatDayMonthTime } from '@/text/datetime.js';
import { collectedAt } from './reply.js';
import type { CardCandidate } from './search.js';

const ADAPTIVE_CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
const ADAPTIVE_CARD_VERSION = '1.5';

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

const cardLine = (c: CardCandidate): string =>
  `${c.label} — ${c.summary} — ${c.status}, atualizado ${dayMonth(c.updatedAt)}`;

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

/** Deterministic text rundown of an organization's active cards. Every value is verbatim. */
export function renderRundown(
  name: string,
  cards: CardCandidate[],
  total: number,
  collectedAtMs: number,
): string {
  const time = collectedAt({ fetchedAt: new Date(collectedAtMs).toISOString() });
  const lines = [`**${name} — ${total} cards ativos (coletado às ${time})**`];
  for (const c of cards.slice(0, RUNDOWN_LINE_CAP)) lines.push(`- ${cardLine(c)}`);
  const hidden = total - Math.min(cards.length, RUNDOWN_LINE_CAP);
  if (hidden > 0) lines.push(`e mais ${hidden} cards — pergunte por um deles`);
  const stale = staleCard(cards, collectedAtMs);
  if (stale) {
    lines.push(`parado há mais tempo: ${stale.label}, sem atualização desde ${dayMonth(stale.updatedAt)}`);
  }
  return lines.join('\n');
}

const candidateId = (c: CardCandidate): string =>
  c.ref.system === 'jira' ? c.ref.issueKey : c.ref.ticketId;

/** Adaptive Card listing candidates with one select button each (plain object, no Teams SDK). */
export function buildCandidateCard(
  name: string,
  cards: CardCandidate[],
  total: number,
): Record<string, unknown> {
  const shown = cards.slice(0, BUTTON_CAP);
  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: `${name} — ${total} cards ativos`, wrap: true, weight: 'Bolder' },
    ...cards.map((c) => ({ type: 'TextBlock', text: cardLine(c), wrap: true, spacing: 'Small' })),
  ];
  const hidden = cards.length - shown.length;
  if (hidden > 0) {
    body.push({ type: 'TextBlock', text: `e mais ${hidden} — refine o nome`, wrap: true, isSubtle: true });
  }
  return {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    body,
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

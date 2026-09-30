import { CARD_FETCH_CAP } from '@/fetch/zendesk.js';
import { normalizeText } from '@/text/normalize.js';
import { assigneeBuckets, statusBuckets, type DistributionDimension } from './grouping.js';
import { collectedTime } from './reply.js';
import { STALE_AFTER_DAYS, datedOldestFirst, dayMonth, isStale } from './rundown.js';
import type { CardCandidate } from './search.js';

export type StatusCount = { status: string; count: number };

export interface PortfolioAggregates {
  total: number; // pre-cap total from the search outcome
  capped: boolean; // total >= CARD_FETCH_CAP
  // Desc by count, verbatim status strings; split because the two systems' nomenclatures differ.
  jiraByStatus: StatusCount[];
  zendeskByStatus: StatusCount[];
  byAssignee: Array<{ assignee: string; count: number }>; // desc; NO_ASSIGNEE for absent
  jiraCount: number;
  zendeskCount: number;
  stale: CardCandidate[]; // > STALE_AFTER_DAYS without update, oldest first
  newest?: CardCandidate;
  oldest?: CardCandidate;
}

const statusCounts = (cards: CardCandidate[], system: CardCandidate['ref']['system']): StatusCount[] =>
  statusBuckets(cards, system).map(({ key, items }) => ({ status: key, count: items.length }));

export function computeAggregates(cards: CardCandidate[], total: number, nowMs: number): PortfolioAggregates {
  const dated = datedOldestFirst(cards);
  return {
    total,
    capped: total >= CARD_FETCH_CAP,
    jiraByStatus: statusCounts(cards, 'jira'),
    zendeskByStatus: statusCounts(cards, 'zendesk'),
    byAssignee: assigneeBuckets(cards).map(({ key, items }) => ({ assignee: key, count: items.length })),
    jiraCount: cards.filter((c) => c.ref.system === 'jira').length,
    zendeskCount: cards.filter((c) => c.ref.system === 'zendesk').length,
    stale: dated.filter((c) => isStale(c, nowMs)),
    newest: dated[dated.length - 1],
    oldest: dated[0],
  };
}

/** The `[estatísticas]` total: exact, or a lower bound once the fetch cap hides the rest. */
const countPhrase = (a: PortfolioAggregates): string =>
  a.capped
    ? `${CARD_FETCH_CAP}+ atividades abertas (mostrando as ${CARD_FETCH_CAP} mais recentes)`
    : `${a.total} atividades abertas`;
const totalLine = (a: PortfolioAggregates): string =>
  a.capped ? countPhrase(a) : `${countPhrase(a)} (Jira: ${a.jiraCount}, Zendesk: ${a.zendeskCount})`;

const joinCounts = (items: Array<[string, number]>): string => items.map(([k, n]) => `${k}: ${n}`).join('; ');
/** One `- por status (<system>): …` line per system that has items; none for an empty system. */
const statusLines = (a: PortfolioAggregates): string[] => {
  const systems: Array<[string, StatusCount[]]> = [['Jira', a.jiraByStatus], ['Zendesk', a.zendeskByStatus]];
  return systems
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => `- por status (${label}): ${joinCounts(list.map((s) => [s.status, s.count]))}`);
};
const assigneeLine = (a: PortfolioAggregates): string =>
  `- por responsável: ${joinCounts(a.byAssignee.map((s) => [s.assignee, s.count]))}`;

const dated = (c: CardCandidate): string => `${c.label} (${dayMonth(c.updatedAt)})`;

/** One `[atividades]` line: bracketed key, its Zendesk pair, summary, status, assignee, day. */
function activityLine(c: CardCandidate): string {
  const key = c.zendeskId ? `[${c.label}] ↔ chamado ${c.zendeskId}` : `[${c.label}]`;
  return [key, c.summary, c.status, c.assignee, `atualizado ${dayMonth(c.updatedAt)}`].filter(Boolean).join(' — ');
}

/**
 * The org portfolio as Claude-facing context: code-computed `[estatísticas]` first, then one
 * line per activity. Every value is verbatim; the model quotes the counts rather than deriving them.
 */
export function renderPortfolio(
  name: string,
  cards: CardCandidate[],
  aggregates: PortfolioAggregates,
  collectedAtMs: number,
): string {
  const time = collectedTime(collectedAtMs);
  const stats = [`- total: ${totalLine(aggregates)}`, ...statusLines(aggregates), assigneeLine(aggregates)];
  if (aggregates.stale.length > 0) {
    const stale = aggregates.stale.map((c) => `${c.label} (desde ${dayMonth(c.updatedAt)})`).join(', ');
    stats.push(`- paradas há mais de ${STALE_AFTER_DAYS} dias: ${stale}`);
  }
  if (aggregates.newest && aggregates.oldest) {
    stats.push(`- mais recente: ${dated(aggregates.newest)} · mais antiga: ${dated(aggregates.oldest)}`);
  }
  return [
    `${name} — contexto de portfólio (coletado às ${time})`,
    '',
    '[estatísticas]',
    ...stats,
    '',
    '[atividades]',
    ...cards.map(activityLine),
  ].join('\n');
}

export type Followup =
  | { kind: 'expand'; section: 'jira' | 'zendesk' | 'all' }
  | { kind: 'counts'; status?: string }
  | { kind: 'distribution'; dimension: DistributionDimension };

/**
 * Status words a user may follow `quantos` with -> normalized substrings a card status must
 * contain to count. `abertos/abertas` have no markers: every listed activity is open.
 * Tenant-tunable.
 */
const BLOCKED = ['bloqueado', 'block'];
const DONE = ['done', 'conclu', 'resolvido', 'closed', 'solved'];
export const STATUS_FILTER_MARKERS: Record<string, string[]> = {
  abertos: [],
  abertas: [],
  pendentes: ['pend', 'aguard', 'waiting', 'hold'],
  bloqueados: BLOCKED,
  bloqueadas: BLOCKED,
  concluidos: DONE,
  concluidas: DONE,
  reprovados: ['reprovado', 'failed'],
};

const EXPAND_SECTIONS = { jira: 'jira', zendesk: 'zendesk' } as const;
/** Leading words a user puts before a follow-up ("quero ver ...", "me mostra ..."); longest first. */
const FILLERS = [
  'quero ver', 'queria ver', 'quero', 'queria', 'me mostra', 'me mostre',
  'mostrar', 'mostra', 'mostre', 'ver', 'exibe', 'exiba', 'listar', 'lista', 'liste',
];
const FILLER = `(?:(?:${FILLERS.join('|')}) )`;
/** Verbs that introduce a distribution ("divide por status"). */
const DISTRIBUTION_VERBS = ['divide', 'divida', 'dividir', 'distribui', 'distribuicao', 'quantos', 'quantas'];
const DISTRIBUTION_DIMENSIONS = { status: 'status', responsaveis: 'assignee', responsavel: 'assignee' } as const;

const EXPAND_SECTION_RE = new RegExp(`^${FILLER}?(?:todos os|todas as) (?:de|do|da) (jira|zendesk)$`);
const EXPAND_ALL_RE = new RegExp(`^${FILLER}tudo$`);
const DISTRIBUTION_RE = new RegExp(
  `^${FILLER}?(?:(?:${DISTRIBUTION_VERBS.join('|')}) )?(?:por|pelos?) (status|responsaveis|responsavel)$`,
);
/** `quantos`, or `quantos [estão] <status word>`; the verb (normalized `esta`/`estao`) only precedes a status. */
const COUNTS_RE = new RegExp(`^quant(?:os|as)(?:(?: est(?:a|ao))? (${Object.keys(STATUS_FILTER_MARKERS).join('|')}))?$`);

/**
 * Whole-message follow-ups on a portfolio. Anchored on purpose: a sentence that merely contains
 * these words ("quantos casos de teste passaram?") is a question for the bound card and must
 * pass through untouched.
 */
export function parseFollowup(text: string): Followup | null {
  const t = normalizeText(text).replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, '').trim();
  // Before counts: "quantos por status" is a distribution, not a count.
  const distribution = DISTRIBUTION_RE.exec(t);
  if (distribution) {
    return { kind: 'distribution', dimension: DISTRIBUTION_DIMENSIONS[distribution[1] as keyof typeof DISTRIBUTION_DIMENSIONS] };
  }
  const section = EXPAND_SECTION_RE.exec(t);
  if (section) return { kind: 'expand', section: EXPAND_SECTIONS[section[1] as keyof typeof EXPAND_SECTIONS] };
  if (EXPAND_ALL_RE.test(t)) return { kind: 'expand', section: 'all' };
  const counts = COUNTS_RE.exec(t);
  if (counts) return counts[1] ? { kind: 'counts', status: counts[1] } : { kind: 'counts' };
  return null;
}

/** Deterministic answer to "quantos?" from the aggregates; with a status word, leads with its sum. */
export function renderCounts(name: string, a: PortfolioAggregates, status?: string): string {
  const markers = status ? STATUS_FILTER_MARKERS[status] : undefined;
  let lead = `${name} — ${totalLine(a)}`;
  if (status && markers) {
    if (markers.length === 0) {
      // Every listed activity is open: exact when uncapped, a lower bound (same frame as the total) when capped.
      lead = a.capped ? `${name} — ${countPhrase(a).replace(' atividades abertas', ` ${status}`)}` : `${name} — ${a.total} ${status}`;
    } else {
      const sum = [...a.jiraByStatus, ...a.zendeskByStatus]
        .filter((s) => markers.some((m) => normalizeText(s.status).includes(m)))
        .reduce((n, s) => n + s.count, 0);
      // Counted over fetched cards only, so a capped total says so instead of implying a global count.
      lead = a.capped
        ? `${name} — ${sum} ${status} entre as ${CARD_FETCH_CAP} mais recentes`
        : `${name} — ${sum} ${status} (de ${countPhrase(a)})`;
    }
  }
  return [`**${lead}**`, ...statusLines(a), assigneeLine(a)].join('\n');
}

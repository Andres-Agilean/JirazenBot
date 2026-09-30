import type { Config } from '@/config.js';
import type { CardRef } from '@/resolve/types.js';
import type { CardBundle, Surface } from '@/bundle/types.js';
import type { AssembleResult } from '@/bundle/assemble.js';
import type { Answer, Turn } from '@/claude/types.js';
import { parseReference } from '@/resolve/parseReference.js';
import { detectPortfolioQuery, parseBuscar, type PortfolioQuery } from '@/resolve/portfolioIntent.js';
import { DEFAULT_SUMMARY_QUESTION, MAX_HISTORY_TURNS } from '@/claude/prompt.js';
import { splitReferenceAndQuestion, isWholeMessageReference } from '../../scripts/splitReference.js';
import { isBundleStale, type Binding, type BindingStore, type Slot } from './bindings.js';
import { buildAnswerCard } from './cards.js';
import { compressCitations, stylePortfolioAnswer } from './citations.js';
import { matchCandidate, type CandidateSet, type CandidateStore } from './candidates.js';
import {
  computeAggregates, parseFollowup, portfolioVocabulary, renderCounts, renderPortfolio, type Followup,
} from './portfolio.js';
import { normalizeText } from '@/text/normalize.js';
import { parseCommand } from './commands.js';
import { cardLabel, formatFooter, withFooter, type Reply } from './reply.js';
import {
  buildCandidateCard, buildDistributionCard, buildPortfolioAnswerCard, buildRundownCard, buildSwitchConfirmCard,
  portfolioFooter, renderDistribution, renderOrgChoices, renderRundown, renderSwitchConfirm,
} from './rundown.js';
import type { CardCandidate, SearchOutcome } from './search.js';
import { surfaceFor } from './surface.js';
import {
  bundleAssignee, bundleSummary, buildReminderConfirmCard, buildReminderPickCard, NO_ASSIGNEE_REPLY, NOT_IN_ORG,
  NOTE_TOO_LONG, parseLembrar, parseReminderPayload, REMINDER_EXPIRED, REMINDER_NEEDS_CARD, renderReminderConfirm,
  renderReminderPick, resolveAssignee, UNCONFIGURED_DIRECTORY,
} from './reminder.js';
import { DIRECTORY_UNAVAILABLE, type DirectoryClientLike, type DirectoryUser } from '@/msgraph/directory.js';

/**
 * What the SDK-agnostic layer needs off an incoming activity. `conversationType` is carried
 * as-is (not yet normalized) so `surfaceFor` can apply its exact-match, fail-closed comparison;
 * `userId` keys the personal slot that lets a participant split off their own card without
 * moving the thread's shared one (spec §4).
 */
export interface Incoming {
  text: string;
  conversationId: string;
  conversationType: string | undefined;
  userId: string;
}

export interface HandleDeps {
  store: BindingStore;
  loadBundle: (ref: CardRef, surface: Surface) => Promise<AssembleResult>;
  answerFn: (bundle: CardBundle, question: string, history: Turn[]) => Promise<Answer>;
  cfg: Config;
  now: () => number;
  /** Candidate lists from portfolio searches, keyed like bindings (always the shared slot). */
  candidates: CandidateStore;
  /** Claude over a rendered portfolio (read-only): answers free-form questions about a candidate set. */
  answerPortfolioFn: (rendered: string, question: string, history: Turn[]) => Promise<Answer>;
  /** Portfolio search by company/client/project name (read-only against Jira and Zendesk). */
  search: (name: string) => Promise<SearchOutcome>;
  /** Org directory for `lembrar responsável`; absent when Graph is not configured (spec §7). */
  directory?: DirectoryClientLike;
  /**
   * Overridable for tests only (e.g. to exercise the "card builder throws" fallback path,
   * spec §7). Production code always falls through to `buildAnswerCard`.
   */
  buildCard?: (
    answerText: string,
    binding: Binding,
    cfg: Config,
    opts: { personal?: boolean },
  ) => Record<string, unknown>;
}

/**
 * What the Refresh button needs to locate the binding it should refetch — the same conversation
 * key `resolveSlots` uses, minus `text`: the button invoke carries no message text (spec §6).
 */
export type RefreshRequest = Pick<Incoming, 'conversationId' | 'conversationType' | 'userId'>;

export const NOTHING_BOUND =
  'Não sei de qual card estamos falando. Envie uma referência — por exemplo `QZ-252`, `chamado 16467` ou o link do card.';

export const NOT_SPLIT =
  'Você já está acompanhando o card da conversa — não há consulta separada para encerrar.';

export const REJOINED_THREAD = 'Você voltou para o card da conversa.';

/**
 * `voltar` with a personal split but no shared binding to rejoin (review finding: Minor 6).
 * NOTHING_BOUND is wrong here -- something IS bound, just not a thread card to return to -- and
 * saying "não sei de qual card estamos falando" while a card is in fact bound contradicts the
 * bot's own state. Distinct from NOTHING_BOUND so the wording never claims nothing is bound.
 */
export const NO_THREAD_TO_REJOIN =
  'Não há um card da conversa para eu voltar. Sua consulta separada continua valendo.';

export const SEARCH_NONE = (name: string) =>
  `Não encontrei atividades abertas para "${name}". Tente outro nome, ou use \`buscar <nome>\`.`;

export const SEARCH_UNAVAILABLE = 'Não consegui buscar agora. Tente novamente em instantes.';

/** A select button whose payload is malformed (should not happen; never a silent drop). */
export const SELECTION_INVALID = 'Não reconheci a seleção. Envie a chave do card (ex.: QZ-252).';

export const HELP_TEXT = [
  'Posso responder perguntas sobre um card do Jira e o chamado do Zendesk correspondente.',
  'Sem um card, você também pode perguntar pelo status de uma empresa ou obra.',
  '',
  '**Para começar**, envie uma referência: `QZ-252`, `chamado 16467`, `#16467` ou um link.',
  'Depois é só perguntar — eu continuo no mesmo card até você trocar.',
  '',
  '**Comandos**',
  // Blank lines between commands: a single newline collapses into one paragraph in Teams markdown.
  '',
  '`ajuda` — esta mensagem',
  '',
  '`atualizar` — busca os dados mais recentes do card',
  '',
  '`buscar` + nome — procura atividades abertas por empresa, cliente ou obra (ex.: `buscar dalle`)',
  '',
  '`quantos?` / `todos os de jira` — depois de uma busca ou resumo, contagens e lista completa',
  '',
  '`voltar` — encerra sua consulta separada e volta para o card da conversa',
].join('\n');

export const JIRA_UNAVAILABLE =
  'Não consegui consultar o Jira ou o Zendesk agora. Tente novamente em instantes.';

export const CLAUDE_UNAVAILABLE =
  'Não consegui gerar a resposta agora. Tente novamente em instantes.';

/**
 * A DM whose activity carries no text (an attachment- or image-only message) must still get a
 * reply — spec §8: the bot must never go silent. See src/teams/app.ts.
 */
export const NO_TEXT_RECEIVED =
  'Não consegui ler nenhum texto nessa mensagem. Envie uma referência de card (ex.: `QZ-252` ou `chamado 16467`) ou sua pergunta.';

export function notFoundReply(message: string): string {
  return message;
}

/**
 * Asks for the issue key rather than offering a numbered menu. A reply of "1" would collide with
 * the bare-number rule (plan §6.1) and be read as Zendesk ticket #1, forcing a pending-choice
 * state and an ordering rule in this pipeline. A key round-trips as an ordinary reference.
 *
 * Zendesk candidates must NOT be rendered as bare numbers: a bare number is exactly what the
 * bare-number guard below reads as a question about the currently bound card, not a rebind
 * (`parseReference`'s WHOLE_MESSAGE_NUMBER path returns `explicit: false`). Rendering them as
 * `chamado 16467` instead makes `parseReference` take the explicit KEYWORD_TICKET path, so
 * replying with the offered string actually rebinds. Jira candidates are already unambiguous
 * issue keys and round-trip as-is.
 */
export function ambiguousReply(candidates: string[], side: 'jira' | 'zendesk'): string {
  const rendered = side === 'zendesk' ? candidates.map((c) => `chamado ${c}`) : candidates;
  return [
    `Essa referência aponta para ${candidates.length} cards — responda com a chave:`,
    ...rendered.map((c) => `- ${c}`),
  ].join('\n');
}

/**
 * Shared by bind() and refresh(): turns a load attempt into either a usable bundle or the exact
 * pt-BR error that describes what went wrong. Both callers must surface `not_found` and
 * `ambiguous` distinctly rather than flattening them into the generic "tente novamente" message
 * (finding: a deleted card previously told every follow-up to retry for up to 24h instead of
 * saying the card is gone).
 */
async function loadOrError(
  ref: CardRef,
  surface: Surface,
  deps: HandleDeps,
): Promise<{ bundle: CardBundle } | { error: string }> {
  let result: AssembleResult;
  try {
    result = await deps.loadBundle(ref, surface);
  } catch {
    return { error: JIRA_UNAVAILABLE };
  }
  if (result.status === 'not_found') return { error: notFoundReply(result.message) };
  if (result.status === 'ambiguous') return { error: ambiguousReply(result.candidates, result.side) };
  return { bundle: result.bundle };
}

async function bind(
  ref: CardRef,
  slot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<{ binding: Binding } | { error: string }> {
  const loaded = await loadOrError(ref, surface, deps);
  if ('error' in loaded) return loaded;

  const binding: Binding = {
    ref,
    bundle: loaded.bundle,
    bundleFetchedAt: deps.now(),
    history: [],
    boundAt: deps.now(),
  };
  await deps.store.set(slot, binding);
  return { binding };
}

/**
 * Answers the question and wraps it as a card (spec §5). `fallbackText` is the display text
 * (citations compressed, footer appended) -- for clients that cannot render cards, and so a
 * malformed card never costs the user their answer (spec §7). Binding history keeps the model's
 * RAW text; compression is display-only.
 */
async function ask(
  binding: Binding,
  question: string,
  slot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<Reply> {
  let result: Answer;
  try {
    result = await deps.answerFn(binding.bundle, question, binding.history);
  } catch {
    return { kind: 'text', text: CLAUDE_UNAVAILABLE };
  }
  const history = [
    ...binding.history,
    { role: 'user' as const, text: question },
    { role: 'assistant' as const, text: result.text },
  ].slice(-MAX_HISTORY_TURNS);
  await deps.store.set(slot, { ...binding, history });

  // Citations are compressed here, at the single display seam, for card body and fallback alike;
  // history above keeps the model's raw text.
  const displayText = compressCitations(result.text, binding.bundle);
  const text = withFooter(displayText, binding, deps.cfg);
  // The personal marker exists so a channel/group-chat reader can see an answer is off the
  // thread's card (spec §4/§5). In a DM there is no thread and no other reader, so a personal
  // slot (set whenever a reference arrives WITH a question, per §4's table) must never grow the
  // marker -- otherwise the header reads "**QZ-252** ↔ chamado 16467 · sua consulta" in a 1:1
  // chat, the one visible break in §4's "collapses to exactly Phase 3 in a DM" guarantee
  // (review finding: Important 3 / cards.ts leak).
  const personal = slot.scope === 'personal' && surface === 'multiparty';
  try {
    const card = (deps.buildCard ?? buildAnswerCard)(displayText, binding, deps.cfg, { personal });
    return { kind: 'card', card, fallbackText: text };
  } catch (err) {
    // A malformed card must never cost the user their answer (spec §7).
    console.error('Falha ao montar o card:', err);
    return { kind: 'text', text };
  }
}

/** Refetches the card in place, preserving the binding and its conversation history. */
async function refresh(
  binding: Binding,
  slot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<{ binding: Binding } | { error: string }> {
  const loaded = await loadOrError(binding.ref, surface, deps);
  if ('error' in loaded) return loaded;

  const refreshed: Binding = { ...binding, bundle: loaded.bundle, bundleFetchedAt: deps.now() };
  await deps.store.set(slot, refreshed);
  return { binding: refreshed };
}

/**
 * Shared by the `atualizar` command and the Refresh button (spec §6): both must go through this
 * exact function so the button's behavior can never drift from what typing `atualizar` does.
 */
async function doRefresh(
  existing: Binding | undefined,
  activeSlot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<Reply> {
  if (!existing) return { kind: 'text', text: NOTHING_BOUND };
  const refreshed = await refresh(existing, activeSlot, surface, deps);
  if ('error' in refreshed) return { kind: 'text', text: refreshed.error };
  return {
    kind: 'text',
    text: `Dados atualizados.\n\n${formatFooter(refreshed.binding, deps.cfg)}`,
  };
}

/**
 * Resolves which binding (if any) governs a conversation -- the sender's personal split takes
 * priority over the thread's shared card (spec §4). Shared by handleMessage and handleRefresh so
 * the Refresh button resolves its binding exactly the way typing a command does.
 */
async function resolveSlots(
  incoming: RefreshRequest,
  deps: HandleDeps,
): Promise<{
  surface: Surface;
  sharedSlot: Slot;
  personalSlot: Slot;
  personalBinding: Binding | undefined;
  sharedBinding: Binding | undefined;
  existing: Binding | undefined;
  /** Writes for the resolved binding go back to the slot it came from, never the other one. */
  activeSlot: Slot;
}> {
  const surface = surfaceFor(incoming.conversationType);
  const sharedSlot: Slot = { scope: 'shared', conversationId: incoming.conversationId };
  const personalSlot: Slot = {
    scope: 'personal', conversationId: incoming.conversationId, userId: incoming.userId,
  };

  const personalBinding = await deps.store.get(personalSlot);
  const sharedBinding = await deps.store.get(sharedSlot);
  const existing = personalBinding ?? sharedBinding;
  const activeSlot: Slot = personalBinding ? personalSlot : sharedSlot;

  return { surface, sharedSlot, personalSlot, personalBinding, sharedBinding, existing, activeSlot };
}

/**
 * Binds a picked/searched card to the room's shared slot and answers the default summary. The
 * sender's personal split is cleared only once the bind SUCCEEDED. The candidate set is kept
 * (spec §2: the portfolio context and a bound card coexist).
 */
async function selectCard(
  ref: CardRef,
  sharedSlot: Slot,
  personalSlot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<Reply> {
  return (await trySelectCard(ref, sharedSlot, personalSlot, surface, deps)).reply;
}

/** A reply plus whether it reports an ERROR (as opposed to a legitimate empty/disambiguation result). */
interface Attempt {
  reply: Reply;
  failed: boolean;
}

/** `selectCard` with an explicit failure signal: a bind error (load failure, not-found, ambiguous) is `failed`. */
async function trySelectCard(
  ref: CardRef,
  sharedSlot: Slot,
  personalSlot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<Attempt> {
  const bound = await bind(ref, sharedSlot, surface, deps);
  if ('error' in bound) return { reply: { kind: 'text', text: bound.error }, failed: true };
  await deps.store.delete(personalSlot);
  return { reply: await ask(bound.binding, DEFAULT_SUMMARY_QUESTION, sharedSlot, surface, deps), failed: false };
}

/**
 * Runs a portfolio search and turns the outcome into a reply. Candidate sets live on the shared
 * slot always: a search reply is a room-level artifact. A rundown never binds -- it stores the
 * same set so typed selection still works.
 */
async function runSearch(
  name: string,
  mode: PortfolioQuery['mode'],
  existing: Binding | undefined,
  sharedSlot: Slot,
  personalSlot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<Attempt> {
  const ok = (reply: Reply): Attempt => ({ reply, failed: false });
  let outcome: SearchOutcome;
  try {
    outcome = await deps.search(name);
  } catch {
    return { reply: { kind: 'text', text: SEARCH_UNAVAILABLE }, failed: true };
  }
  switch (outcome.kind) {
    case 'orgs':
      return ok({ kind: 'text', text: renderOrgChoices(outcome.name, outcome.orgs) });
    case 'bind':
      // With a card already bound, a search never moves it (spec §3): offer the one match as a
      // button, exactly like a longer list. Only with nothing bound does a lone match bind.
      if (existing) return ok(await offerCandidates(outcome.displayName, [outcome.candidate], 1, 'candidates', sharedSlot, deps));
      return trySelectCard(outcome.candidate.ref, sharedSlot, personalSlot, surface, deps);
    case 'none':
      return ok({ kind: 'text', text: SEARCH_NONE(outcome.name) });
    case 'cards':
      return ok(await offerCandidates(outcome.displayName, outcome.cards, outcome.total, mode, sharedSlot, deps));
  }
}

/**
 * The typed `buscar <nome>` behavior, shared with the confirm card's Buscar button (spec §11) so
 * the button can never drift from the command: same search, same slot semantics. Typed `buscar`
 * is always `candidates` mode; the button passes the mode the detector saw (spec §11.2).
 */
function runBuscar(
  name: string,
  existing: Binding | undefined,
  sharedSlot: Slot,
  personalSlot: Slot,
  surface: Surface,
  deps: HandleDeps,
  mode: PortfolioQuery['mode'] = 'candidates',
): Promise<Attempt> {
  return runSearch(name, mode, existing, sharedSlot, personalSlot, surface, deps);
}

/**
 * The portfolio detector with the vocabulary filter (spec §11.2), shared by the unbound and the
 * bound paths: a LOOSE match whose name is the stored portfolio's own vocabulary (a status word, a
 * status present in the set, an assignee) is a follow-up on that context, not a switch -> null.
 */
function detectSwitch(text: string, set: CandidateSet | undefined): PortfolioQuery | null {
  const query = detectPortfolioQuery(text);
  if (query?.loose && set && portfolioVocabulary(set.candidates).has(normalizeText(query.name).trim())) return null;
  return query;
}

/**
 * Answers a question on the bound card, refetching first when the bundle has gone stale. Shared by
 * the free-form fallthrough and the confirm card's Continuar button (spec §11).
 */
async function askBound(
  existing: Binding,
  question: string,
  activeSlot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<Reply> {
  let binding = existing;
  if (isBundleStale(binding, deps.now())) {
    const refreshed = await refresh(binding, activeSlot, surface, deps);
    if ('error' in refreshed) return { kind: 'text', text: refreshed.error };
    binding = refreshed.binding;
  }
  return ask(binding, question, activeSlot, surface, deps);
}

/**
 * Stores a candidate set on the shared slot and replies with it: a text rundown, or a card with
 * one select button per candidate. A rundown never binds -- the stored set keeps typed selection
 * working.
 */
async function offerCandidates(
  name: string,
  cards: CardCandidate[],
  total: number,
  mode: PortfolioQuery['mode'],
  sharedSlot: Slot,
  deps: HandleDeps,
): Promise<Reply> {
  await deps.candidates.set(sharedSlot, {
    name,
    candidates: cards,
    createdAt: deps.now(),
    total,
    collectedAtMs: deps.now(),
    history: [],
  });
  const rundown = renderRundown(name, cards, total, deps.now(), deps.cfg);
  const card = mode === 'rundown'
    ? buildRundownCard(name, cards, total, deps.now(), deps.cfg)
    : buildCandidateCard(name, cards, total, deps.cfg);
  return { kind: 'card', card, fallbackText: rundown };
}

/** Deterministic follow-up on the stored set: `expand` shows sections uncapped, `counts` answers from aggregates. */
function answerFollowup(followup: Followup, set: CandidateSet, deps: HandleDeps): Reply {
  if (followup.kind === 'counts') {
    const aggregates = computeAggregates(set.candidates, set.total, set.collectedAtMs);
    return { kind: 'text', text: renderCounts(set.name, aggregates, set.collectedAtMs, followup.status) };
  }
  if (followup.kind === 'distribution') {
    const args = [set.name, set.candidates, followup.dimension, set.total, set.collectedAtMs, deps.cfg] as const;
    return { kind: 'card', card: buildDistributionCard(...args), fallbackText: renderDistribution(...args) };
  }
  return {
    kind: 'card',
    card: buildRundownCard(set.name, set.candidates, set.total, set.collectedAtMs, deps.cfg, followup.section),
    fallbackText: renderRundown(set.name, set.candidates, set.total, set.collectedAtMs, deps.cfg, followup.section),
  };
}

/**
 * Free-form question over the stored portfolio (nothing bound). Aggregates are computed in code and
 * handed to Claude as `[estatísticas]`; history lives on the set and dies with it on a context switch.
 */
async function askPortfolio(
  set: CandidateSet,
  question: string,
  sharedSlot: Slot,
  deps: HandleDeps,
): Promise<Reply> {
  // Aggregates are as-of store time (spec §2), never now(): the rendered context must stay
  // byte-identical across turns or the cached prompt prefix is invalidated.
  const aggregates = computeAggregates(set.candidates, set.total, set.collectedAtMs);
  const rendered = renderPortfolio(set.name, set.candidates, aggregates, set.collectedAtMs);
  let result: Answer;
  try {
    result = await deps.answerPortfolioFn(rendered, question, set.history);
  } catch {
    return { kind: 'text', text: CLAUDE_UNAVAILABLE };
  }
  const history = [
    ...set.history,
    { role: 'user' as const, text: question },
    { role: 'assistant' as const, text: result.text },
  ].slice(-MAX_HISTORY_TURNS);
  // Defense in depth: app.ts already serializes text and button paths per conversation
  // (runExclusive), so a same-conversation race cannot interleave today. Still, write back only if
  // the live set is the one we answered over -- otherwise a search/selection that replaced it
  // during the Claude call would be clobbered by this stale snapshot. The answer still goes out.
  const live = await deps.candidates.get(sharedSlot);
  if (live && live.createdAt === set.createdAt && live.name === set.name) {
    await deps.candidates.set(sharedSlot, { ...live, history });
  }

  const displayText = stylePortfolioAnswer(result.text, set, deps.cfg);
  const fallbackText = `${displayText}\n\n${portfolioFooter(set.name, set.collectedAtMs)}`;
  try {
    return { kind: 'card', card: buildPortfolioAnswerCard(set.name, displayText, set.collectedAtMs), fallbackText };
  } catch (err) {
    console.error('Falha ao montar o card:', err);
    return { kind: 'text', text: fallbackText };
  }
}

/** The confirmation card reply for one resolved person: the single builder behind both the single-match and pick paths. */
function confirmReply(user: DirectoryUser, binding: Binding, note: string | undefined): Reply {
  const key = cardLabel(binding.bundle);
  const summary = bundleSummary(binding.bundle);
  return {
    kind: 'card',
    card: buildReminderConfirmCard(user, key, summary, note),
    fallbackText: renderReminderConfirm(user, key, summary, note),
  };
}

/**
 * `lembrar responsável` (reminder spec §3-§5): resolves the bound card's assignee in the org
 * directory and answers with a confirmation (one match), a clarification (several) or an honest
 * reply. Never sends anything -- delivery waits for the confirmation click.
 */
async function remindAssignee(
  parsed: NonNullable<ReturnType<typeof parseLembrar>>,
  existing: Binding | undefined,
  deps: HandleDeps,
): Promise<Reply> {
  const text = (t: string): Reply => ({ kind: 'text', text: t });
  if (!existing) return text(REMINDER_NEEDS_CARD);
  if (parsed.tooLong) return text(NOTE_TOO_LONG);
  const name = bundleAssignee(existing.bundle);
  if (!name) return text(NO_ASSIGNEE_REPLY);
  if (!deps.directory) return text(UNCONFIGURED_DIRECTORY);
  let users: DirectoryUser[];
  try {
    users = await resolveAssignee(name, deps.directory);
  } catch {
    return text(DIRECTORY_UNAVAILABLE);
  }
  if (users.length === 0) return text(NOT_IN_ORG(name));
  if (users.length === 1) return confirmReply(users[0]!, existing, parsed.note);
  const key = cardLabel(existing.bundle);
  return {
    kind: 'card',
    card: buildReminderPickCard(users, key, parsed.note),
    fallbackText: renderReminderPick(users, key, parsed.note),
  };
}

/**
 * The pick card's button: answers with the same confirmation card for the chosen person. The
 * payload's card must still be the bound one -- otherwise the summary would describe a different
 * card than the one being confirmed, so a moved-on or expired binding says so (spec §5).
 */
export async function handleReminderPick(
  incoming: RefreshRequest,
  data: unknown,
  deps: HandleDeps,
): Promise<Reply[]> {
  const payload = parseReminderPayload(data);
  if (!payload) return [{ kind: 'text', text: SELECTION_INVALID }];
  const { existing } = await resolveSlots(incoming, deps);
  if (!existing || cardLabel(existing.bundle) !== payload.cardKey) return [{ kind: 'text', text: REMINDER_EXPIRED }];
  const user: DirectoryUser = { id: payload.userId, displayName: payload.userName, mail: payload.userMail };
  return [confirmReply(user, existing, payload.note)];
}

/**
 * The whole DM pipeline (Phase 3 spec §5). Returns replies as data so the Teams SDK stays in
 * app.ts and this is testable offline.
 */
export async function handleMessage(
  incoming: Incoming,
  deps: HandleDeps,
): Promise<Reply[]> {
  const { text } = incoming;
  const {
    surface, sharedSlot, personalSlot, personalBinding, sharedBinding, existing, activeSlot,
  } = await resolveSlots(incoming, deps);

  // 1. Commands
  const command = parseCommand(text);
  if (command === 'ajuda') {
    if (!existing) return [{ kind: 'text', text: HELP_TEXT }];
    return [{ kind: 'text', text: `${HELP_TEXT}\n\n${formatFooter(existing, deps.cfg)}` }];
  }
  if (command === 'atualizar') {
    return [await doRefresh(existing, activeSlot, surface, deps)];
  }
  if (command === 'voltar') {
    if (!personalBinding) return [{ kind: 'text', text: NOT_SPLIT }];
    // Check for a shared binding BEFORE deleting the personal one: with nothing to rejoin, the
    // sender's split is all they have, and destroying it would leave them with nothing bound at
    // all instead of just saying there is no thread card to return to (review finding: Minor 5).
    if (!sharedBinding) {
      return [{
        kind: 'text',
        text: `${NO_THREAD_TO_REJOIN}\n\n${formatFooter(personalBinding, deps.cfg)}`,
      }];
    }
    await deps.store.delete(personalSlot);
    return [{ kind: 'text', text: `${REJOINED_THREAD}\n\n${formatFooter(sharedBinding, deps.cfg)}` }];
  }

  // 1a. `lembrar responsável`: a whole-message command on the bound card (reminder spec §3).
  const lembrar = parseLembrar(text);
  if (lembrar) return [await remindAssignee(lembrar, existing, deps)];

  // 1b. Explicit search: works with or without a binding and never unbinds.
  const buscarName = parseBuscar(text);
  if (buscarName) {
    return [(await runBuscar(buscarName, existing, sharedSlot, personalSlot, surface, deps)).reply];
  }

  // 1c. Whole-message portfolio follow-ups ("todos os de jira", "quantos"): deterministic, and
  // consulted only when a candidate set exists -- with no set they fall through untouched.
  const followup = parseFollowup(text);
  if (followup) {
    const set = await deps.candidates.get(sharedSlot);
    if (set) return [answerFollowup(followup, set, deps)];
  }

  // 2 & 3. A reference in the message, with or without a question.
  const split = splitReferenceAndQuestion(text, deps.cfg.allowedProjects);
  const bare = split ? null : parseReference(text, deps.cfg.allowedProjects);
  const ref = split?.ref ?? bare;

  // The bare-number guard: with a card already bound, a non-explicit reference (a whole-message
  // number) is a question, not a rebind. "vimos 12 casos desses" must not switch cards.
  const isRebind = ref !== null && (ref.explicit || !existing);

  if (isRebind && ref) {
    // Addressed to the room only when the ENTIRE message is the reference (spec §4) -- a
    // reference embedded anywhere else in a question is the sender's own enquiry and must not
    // move the thread's shared card. `splitReferenceAndQuestion`'s prefix-only check cannot tell
    // "AGL-900 qual o status?" apart from "qual o status do AGL-900?"; isWholeMessageReference
    // can (review finding: Important 2).
    const wholeMessage = isWholeMessageReference(text, deps.cfg.allowedProjects);
    const targetSlot = wholeMessage ? sharedSlot : personalSlot;
    const bound = await bind(ref, targetSlot, surface, deps);
    if ('error' in bound) return [{ kind: 'text', text: bound.error }];
    // Only clear the sender's split once the rebind actually SUCCEEDED. Clearing it first would
    // mean a typo'd reference (e.g. a not_found key) silently destroys an existing split and
    // leaves the sender's next question answered against the room's card instead
    // (review finding: Important 1).
    if (wholeMessage) await deps.store.delete(personalSlot);
    // The portfolio context is NOT cleared by a card bind (spec §2): the two coexist.
    const question = split?.question ?? DEFAULT_SUMMARY_QUESTION;
    return [await ask(bound.binding, question, targetSlot, surface, deps)];
  }

  // 3b. Typed selection from a listed candidate set. Only an exact label match acts; no match
  // falls through to Q&A or the bound card (spec §5a). Exact-label-only prevents hijacking
  // ordinary questions ("sim", "obra norte").
  const candidateSet = await deps.candidates.get(sharedSlot);
  if (candidateSet) {
    const picked = matchCandidate(text, candidateSet);
    if (picked) {
      return [await selectCard(picked.ref, sharedSlot, personalSlot, surface, deps)];
    }
  }

  // 4. A question about the bound card -- unless it is shaped like a portfolio question (spec §11):
  // then a confirm card lets one click pick the search or the bound card. Loose bare-name shapes
  // count too (spec §11.1: the card makes a false positive one click; the detector's generic-tail
  // guard keeps "qual o status do chamado" on the card). Mid-sentence anchors ("o problema da obra
  // Flora persiste?") also raise the card -- accepted by §11.
  if (existing) {
    const switchQuery = detectSwitch(text, candidateSet);
    if (switchQuery) {
      const boundLabel = cardLabel(existing.bundle);
      return [{
        kind: 'card',
        card: buildSwitchConfirmCard(switchQuery.name, text, switchQuery.mode, boundLabel),
        fallbackText: renderSwitchConfirm(switchQuery.name, boundLabel),
      }];
    }
    return [await askBound(existing, text, activeSlot, surface, deps)];
  }

  // 5. Nothing bound and nothing to bind. Reachable ONLY here, so a bound conversation's question
  // can never be diverted into a search or a portfolio answer.
  // 5a. A named entity ("como está a empresa X?") is a context switch: search first, even when a
  // portfolio is stored (the new set starts with empty history).
  // Loose bare-name shapes switch on real names even with a set stored; the portfolio's own
  // vocabulary ("bloqueados", an assignee) stays a follow-up (spec §11.2, superseding §10.4's gate).
  const portfolio = detectSwitch(text, candidateSet);
  if (portfolio) {
    return [(await runSearch(portfolio.name, portfolio.mode, existing, sharedSlot, personalSlot, surface, deps)).reply];
  }
  // 5b. Otherwise free-form text is a question about the stored portfolio.
  if (candidateSet) return [await askPortfolio(candidateSet, text, sharedSlot, deps)];
  // 5c. Nothing to talk about.
  return [{ kind: 'text', text: NOTHING_BOUND }];
}

const NUMERIC_ID = /^\d+$/;

/**
 * A button payload is client-supplied data that ends up in vendor URL paths, so it is validated
 * like typed input: a Jira id must parse (through the same project scoping as typed references)
 * to exactly that issue key, and a Zendesk id must be all digits. Anything else is null.
 */
function selectionRef(system: 'jira' | 'zendesk', id: string, allowedProjects: string[]): CardRef | null {
  if (system === 'zendesk') {
    return NUMERIC_ID.test(id) ? { system, ticketId: id, explicit: true } : null;
  }
  const parsed = parseReference(id, allowedProjects);
  return parsed?.system === 'jira' && parsed.issueKey === id ? { ...parsed, explicit: true } : null;
}

/**
 * The candidate card's select button (`Action.Execute`). The payload is self-sufficient -- it
 * carries system and id -- so it works even after the candidate set expired or was cleared.
 */
export async function handleSelect(
  incoming: RefreshRequest,
  data: unknown,
  deps: HandleDeps,
): Promise<Reply[]> {
  // Guard against undefined, null, or non-object payloads (should not happen, never a silent drop).
  if (typeof data !== 'object' || data === null) {
    return [{ kind: 'text', text: SELECTION_INVALID }];
  }
  const { system, id } = data as { system?: string; id?: string };
  if ((system !== 'jira' && system !== 'zendesk') || typeof id !== 'string' || id.trim() === '') {
    return [{ kind: 'text', text: SELECTION_INVALID }];
  }
  const ref = selectionRef(system, id.trim(), deps.cfg.allowedProjects);
  if (!ref) return [{ kind: 'text', text: SELECTION_INVALID }];
  const { surface, sharedSlot, personalSlot } = await resolveSlots(incoming, deps);
  return [await selectCard(ref, sharedSlot, personalSlot, surface, deps)];
}

/** A confirm-card payload field: a non-blank string, or null (client data is validated like typed input). */
function payloadString(data: unknown, field: 'name' | 'text'): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The confirm payload's detected mode; unknown -> null. Absent -> `candidates`, because confirm
 * cards sent before the payload carried a mode may still sit in chat history and be clicked.
 */
function payloadMode(data: unknown): PortfolioQuery['mode'] | null {
  const mode = (data as Record<string, unknown>).mode;
  if (mode === undefined) return 'candidates';
  return mode === 'rundown' || mode === 'candidates' ? mode : null;
}

/**
 * The confirm card's Buscar button (spec §11, §11.2): the typed `buscar <nome>` search, run in the
 * detected mode, after UNBINDING the current card -- the user answered "switch or stay?" with
 * switch, so the old card must stop catching their next question. The unbind is undone if the
 * search itself fails, so an outage never leaves the user with nothing bound.
 */
export async function handleSwitchBuscar(
  incoming: RefreshRequest,
  data: unknown,
  deps: HandleDeps,
): Promise<Reply[]> {
  const name = payloadString(data, 'name');
  const mode = name ? payloadMode(data) : null;
  if (!name || !mode) return [{ kind: 'text', text: SELECTION_INVALID }];
  const before = await resolveSlots(incoming, deps);
  const restore = async (): Promise<void> => {
    if (before.existing) await deps.store.set(before.activeSlot, before.existing);
  };
  // Only the ACTIVE slot is unbound. With a personal split over a shared card, the shared card is
  // the room's and survives; it may re-raise the interstitial later (accepted by spec §11.2).
  // A restore goes back to that same slot.
  if (before.existing) await deps.store.delete(before.activeSlot);
  try {
    // Re-resolve: a thread's shared card may still be bound behind a deleted personal split.
    const { surface, sharedSlot, personalSlot, existing } = await resolveSlots(incoming, deps);
    const { reply, failed } = await runBuscar(name, existing, sharedSlot, personalSlot, surface, deps, mode);
    // Errors (outage, load failure, not-found) never cost the user their card; `none`/`orgs`
    // intentionally do (spec §11.2): the user chose to move on.
    if (failed) await restore();
    return [reply];
  } catch (err) {
    await restore();
    throw err;
  }
}

/**
 * The confirm card's Continuar button (spec §11): the ORIGINAL message text goes to the bound
 * card's ordinary answer path. With the binding gone (24h expiry) it says so rather than go silent.
 */
export async function handleSwitchContinuar(
  incoming: RefreshRequest,
  data: unknown,
  deps: HandleDeps,
): Promise<Reply[]> {
  const text = payloadString(data, 'text');
  if (!text) return [{ kind: 'text', text: SELECTION_INVALID }];
  const { surface, existing, activeSlot } = await resolveSlots(incoming, deps);
  if (!existing) return [{ kind: 'text', text: NOTHING_BOUND }];
  return [await askBound(existing, text, activeSlot, surface, deps)];
}

/**
 * The Refresh button's invoke handler (spec §6). Resolves the binding exactly the way
 * handleMessage does and delegates to the same `doRefresh` the `atualizar` command uses, so the
 * button can never drift from what typing the command does.
 */
export async function handleRefresh(
  incoming: RefreshRequest,
  deps: HandleDeps,
): Promise<Reply[]> {
  const { existing, activeSlot, surface } = await resolveSlots(incoming, deps);
  return [await doRefresh(existing, activeSlot, surface, deps)];
}

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
import { compressCitations } from './citations.js';
import { matchCandidate, type CandidateStore } from './candidates.js';
import { parseCommand } from './commands.js';
import { formatFooter, withFooter, type Reply } from './reply.js';
import { buildCandidateCard, renderOrgChoices, renderRundown } from './rundown.js';
import type { CardCandidate, SearchOutcome } from './search.js';
import { surfaceFor } from './surface.js';

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
  /** Portfolio search by company/client/project name (read-only against Jira and Zendesk). */
  search: (name: string) => Promise<SearchOutcome>;
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
  `Não encontrei cards ativos para "${name}". Tente outro nome, ou use \`buscar <nome>\`.`;

export const SEARCH_UNAVAILABLE = 'Não consegui buscar agora. Tente novamente em instantes.';

export const SELECTION_AMBIGUOUS =
  'Mais de um card corresponde — seja mais específico ou toque no botão do card desejado.';

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
  '`ajuda` — esta mensagem',
  '`atualizar` — busca os dados mais recentes do card',
  '`buscar <nome>` — procura cards ativos por empresa, cliente ou obra',
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
 * candidate set and the sender's personal split are cleared only once the bind SUCCEEDED, so a
 * failed load leaves the list on screen usable (same rule as the whole-message rebind above).
 */
async function selectCard(
  ref: CardRef,
  sharedSlot: Slot,
  personalSlot: Slot,
  surface: Surface,
  deps: HandleDeps,
): Promise<Reply> {
  const bound = await bind(ref, sharedSlot, surface, deps);
  if ('error' in bound) return { kind: 'text', text: bound.error };
  await deps.store.delete(personalSlot);
  await deps.candidates.delete(sharedSlot);
  return ask(bound.binding, DEFAULT_SUMMARY_QUESTION, sharedSlot, surface, deps);
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
): Promise<Reply> {
  let outcome: SearchOutcome;
  try {
    outcome = await deps.search(name);
  } catch {
    return { kind: 'text', text: SEARCH_UNAVAILABLE };
  }
  switch (outcome.kind) {
    case 'orgs':
      return { kind: 'text', text: renderOrgChoices(outcome.name, outcome.orgs) };
    case 'bind':
      // With a card already bound, a search never moves it (spec §3): offer the one match as a
      // button, exactly like a longer list. Only with nothing bound does a lone match bind.
      if (existing) return offerCandidates(name, [outcome.candidate], 1, 'candidates', sharedSlot, deps);
      return selectCard(outcome.candidate.ref, sharedSlot, personalSlot, surface, deps);
    case 'none':
      return { kind: 'text', text: SEARCH_NONE(outcome.name) };
    case 'cards':
      return offerCandidates(outcome.name, outcome.cards, outcome.total, mode, sharedSlot, deps);
  }
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
  await deps.candidates.set(sharedSlot, { name, candidates: cards, createdAt: deps.now() });
  const rundown = renderRundown(name, cards, total, deps.now());
  if (mode === 'rundown') return { kind: 'text', text: rundown };
  return { kind: 'card', card: buildCandidateCard(name, cards, total), fallbackText: rundown };
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

  // 1b. Explicit search: works with or without a binding and never unbinds.
  const buscarName = parseBuscar(text);
  if (buscarName) {
    return [await runSearch(buscarName, 'candidates', existing, sharedSlot, personalSlot, surface, deps)];
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
    // A successful rebind makes any listed candidates stale; they must not intercept later text.
    await deps.candidates.delete(sharedSlot);
    const question = split?.question ?? DEFAULT_SUMMARY_QUESTION;
    return [await ask(bound.binding, question, targetSlot, surface, deps)];
  }

  // 3b. Typed selection from a listed candidate set. Only a real match acts; no match falls
  // through untouched so a bound conversation's question still reaches the card. With a card
  // bound, only an exact label selects (a loose match would hijack ordinary questions such as
  // "sim"), and an unclear match is a question, never SELECTION_AMBIGUOUS.
  const candidateSet = await deps.candidates.get(sharedSlot);
  if (candidateSet) {
    const picked = matchCandidate(text, candidateSet, { exactOnly: existing !== undefined });
    if (picked === 'ambiguous') return [{ kind: 'text', text: SELECTION_AMBIGUOUS }];
    if (picked) {
      return [await selectCard(picked.ref, sharedSlot, personalSlot, surface, deps)];
    }
  }

  // 4. A question about the bound card.
  if (existing) {
    let binding = existing;
    if (isBundleStale(binding, deps.now())) {
      const refreshed = await refresh(binding, activeSlot, surface, deps);
      if ('error' in refreshed) return [{ kind: 'text', text: refreshed.error }];
      binding = refreshed.binding;
    }
    return [await ask(binding, text, activeSlot, surface, deps)];
  }

  // 5. Nothing bound and nothing to bind: a vague portfolio question ("como está a empresa X?")
  // gets a search; anything else gets the usual prompt. Reachable ONLY here, so a bound
  // conversation's question can never be diverted into a search.
  const portfolio = detectPortfolioQuery(text);
  if (portfolio) {
    return [await runSearch(portfolio.name, portfolio.mode, existing, sharedSlot, personalSlot, surface, deps)];
  }
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

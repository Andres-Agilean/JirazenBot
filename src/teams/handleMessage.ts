import type { Config } from '@/config.js';
import type { CardRef } from '@/resolve/types.js';
import type { CardBundle, Surface } from '@/bundle/types.js';
import type { AssembleResult } from '@/bundle/assemble.js';
import type { Answer, Turn } from '@/claude/types.js';
import { parseReference } from '@/resolve/parseReference.js';
import { DEFAULT_SUMMARY_QUESTION, MAX_HISTORY_TURNS } from '@/claude/prompt.js';
import { splitReferenceAndQuestion, isWholeMessageReference } from '../../scripts/splitReference.js';
import { isBundleStale, type Binding, type BindingStore, type Slot } from './bindings.js';
import { buildAnswerCard } from './cards.js';
import { parseCommand } from './commands.js';
import { formatFooter, withFooter, type Reply } from './reply.js';
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

export const HELP_TEXT = [
  'Posso responder perguntas sobre um card do Jira e o chamado do Zendesk correspondente.',
  '',
  '**Para começar**, envie uma referência: `QZ-252`, `chamado 16467`, `#16467` ou um link.',
  'Depois é só perguntar — eu continuo no mesmo card até você trocar.',
  '',
  '**Comandos**',
  '`ajuda` — esta mensagem',
  '`atualizar` — busca os dados mais recentes do card',
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
 * Answers the question and wraps it as a card (spec §5), keeping the Phase 3 plain-text answer
 * as `fallbackText` byte-for-byte -- both for clients that cannot render cards and so a malformed
 * card never costs the user their answer (spec §7).
 */
async function ask(
  binding: Binding,
  question: string,
  slot: Slot,
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

  const text = withFooter(result.text, binding, deps.cfg);
  const personal = slot.scope === 'personal';
  try {
    const card = (deps.buildCard ?? buildAnswerCard)(result.text, binding, deps.cfg, { personal });
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
    if (!sharedBinding) return [{ kind: 'text', text: NOTHING_BOUND }];
    await deps.store.delete(personalSlot);
    return [{ kind: 'text', text: `${REJOINED_THREAD}\n\n${formatFooter(sharedBinding, deps.cfg)}` }];
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
    const question = split?.question ?? DEFAULT_SUMMARY_QUESTION;
    return [await ask(bound.binding, question, targetSlot, deps)];
  }

  // 4. A question about the bound card.
  if (existing) {
    let binding = existing;
    if (isBundleStale(binding, deps.now())) {
      const refreshed = await refresh(binding, activeSlot, surface, deps);
      if ('error' in refreshed) return [{ kind: 'text', text: refreshed.error }];
      binding = refreshed.binding;
    }
    return [await ask(binding, text, activeSlot, deps)];
  }

  // 5. Nothing bound and nothing to bind.
  return [{ kind: 'text', text: NOTHING_BOUND }];
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

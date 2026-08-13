import type { Config } from '@/config.js';
import type { CardRef } from '@/resolve/types.js';
import type { CardBundle } from '@/bundle/types.js';
import type { AssembleResult } from '@/bundle/assemble.js';
import type { Answer, Turn } from '@/claude/types.js';
import { parseReference } from '@/resolve/parseReference.js';
import { DEFAULT_SUMMARY_QUESTION, MAX_HISTORY_TURNS } from '@/claude/prompt.js';
import { splitReferenceAndQuestion } from '../../scripts/splitReference.js';
import { isBundleStale, type Binding, type BindingStore } from './bindings.js';
import { parseCommand } from './commands.js';
import { formatFooter, withFooter } from './reply.js';

export interface HandleDeps {
  store: BindingStore;
  loadBundle: (ref: CardRef) => Promise<AssembleResult>;
  answerFn: (bundle: CardBundle, question: string, history: Turn[]) => Promise<Answer>;
  cfg: Config;
  now: () => number;
}

export const NOTHING_BOUND =
  'Não sei de qual card estamos falando. Envie uma referência — por exemplo `QZ-252`, `chamado 16467` ou o link do card.';

export const HELP_TEXT = [
  'Posso responder perguntas sobre um card do Jira e o chamado do Zendesk correspondente.',
  '',
  '**Para começar**, envie uma referência: `QZ-252`, `chamado 16467`, `#16467` ou um link.',
  'Depois é só perguntar — eu continuo no mesmo card até você trocar.',
  '',
  '**Comandos**',
  '`ajuda` — esta mensagem',
  '`atualizar` — busca os dados mais recentes do card',
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
  deps: HandleDeps,
): Promise<{ bundle: CardBundle } | { error: string }> {
  let result: AssembleResult;
  try {
    result = await deps.loadBundle(ref);
  } catch {
    return { error: JIRA_UNAVAILABLE };
  }
  if (result.status === 'not_found') return { error: notFoundReply(result.message) };
  if (result.status === 'ambiguous') return { error: ambiguousReply(result.candidates, result.side) };
  return { bundle: result.bundle };
}

async function bind(
  ref: CardRef,
  key: string,
  deps: HandleDeps,
): Promise<{ binding: Binding } | { error: string }> {
  const loaded = await loadOrError(ref, deps);
  if ('error' in loaded) return loaded;

  const binding: Binding = {
    ref,
    bundle: loaded.bundle,
    bundleFetchedAt: deps.now(),
    history: [],
    boundAt: deps.now(),
  };
  await deps.store.set(key, binding);
  return { binding };
}

async function ask(
  binding: Binding,
  question: string,
  key: string,
  deps: HandleDeps,
): Promise<string> {
  let result: Answer;
  try {
    result = await deps.answerFn(binding.bundle, question, binding.history);
  } catch {
    return CLAUDE_UNAVAILABLE;
  }
  const history = [
    ...binding.history,
    { role: 'user' as const, text: question },
    { role: 'assistant' as const, text: result.text },
  ].slice(-MAX_HISTORY_TURNS);
  await deps.store.set(key, { ...binding, history });
  return withFooter(result.text, binding, deps.cfg);
}

/** Refetches the card in place, preserving the binding and its conversation history. */
async function refresh(
  binding: Binding,
  key: string,
  deps: HandleDeps,
): Promise<{ binding: Binding } | { error: string }> {
  const loaded = await loadOrError(binding.ref, deps);
  if ('error' in loaded) return loaded;

  const refreshed: Binding = { ...binding, bundle: loaded.bundle, bundleFetchedAt: deps.now() };
  await deps.store.set(key, refreshed);
  return { binding: refreshed };
}

/**
 * The whole DM pipeline (Phase 3 spec §5). Returns replies as data so the Teams SDK stays in
 * app.ts and this is testable offline.
 */
export async function handleMessage(
  text: string,
  key: string,
  deps: HandleDeps,
): Promise<string[]> {
  const existing = await deps.store.get(key);

  // 1. Commands
  const command = parseCommand(text);
  if (command === 'ajuda') {
    if (!existing) return [HELP_TEXT];
    return [`${HELP_TEXT}\n\n${formatFooter(existing, deps.cfg)}`];
  }
  if (command === 'atualizar') {
    if (!existing) return [NOTHING_BOUND];
    const refreshed = await refresh(existing, key, deps);
    if ('error' in refreshed) return [refreshed.error];
    return [`Dados atualizados.\n\n${formatFooter(refreshed.binding, deps.cfg)}`];
  }

  // 2 & 3. A reference in the message, with or without a question.
  const split = splitReferenceAndQuestion(text, deps.cfg.allowedProjects);
  const bare = split ? null : parseReference(text, deps.cfg.allowedProjects);
  const ref = split?.ref ?? bare;

  // The bare-number guard: with a card already bound, a non-explicit reference (a whole-message
  // number) is a question, not a rebind. "vimos 12 casos desses" must not switch cards.
  const isRebind = ref !== null && (ref.explicit || !existing);

  if (isRebind && ref) {
    const bound = await bind(ref, key, deps);
    if ('error' in bound) return [bound.error];
    const question = split?.question ?? DEFAULT_SUMMARY_QUESTION;
    return [await ask(bound.binding, question, key, deps)];
  }

  // 4. A question about the bound card.
  if (existing) {
    let binding = existing;
    if (isBundleStale(binding, deps.now())) {
      const refreshed = await refresh(binding, key, deps);
      if ('error' in refreshed) return [refreshed.error];
      binding = refreshed.binding;
    }
    return [await ask(binding, text, key, deps)];
  }

  // 5. Nothing bound and nothing to bind.
  return [NOTHING_BOUND];
}

import { App, type AppOptions, type IPlugin } from '@microsoft/teams.apps';
import { REFRESH_ACTION } from './cards.js';
import { handleMessage, handleRefresh, handleSelect, NO_TEXT_RECEIVED, type HandleDeps } from './handleMessage.js';
import { appOptionsForAuthMode, type AuthMode, type TeamsAppAuthOptions } from './authMode.js';
import { botMentions, stripMentions, type MentionLike } from './mentions.js';
import { runExclusive } from './serialize.js';
import { SELECT_ACTION } from './rundown.js';
import type { Reply } from './reply.js';

export const UNEXPECTED_ERROR_REPLY = 'Algo deu errado do meu lado. Tente novamente em instantes.';

/** The Bot Framework attachment content type for an Adaptive Card (spec §5). */
const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

/**
 * The route name @microsoft/teams.apps aliases from the Bot Framework invoke name
 * 'adaptiveCard/action' (see node_modules/@microsoft/teams.apps/dist/routes/invoke/index.d.ts's
 * INVOKE_ALIASES) -- not to be confused with ADAPTIVE_CARD_CONTENT_TYPE above, which labels a
 * message attachment rather than an invoke route.
 */
const CARD_ACTION_ROUTE = 'card.action' as const;

/**
 * Action.Execute's "silent ack" response type. @microsoft/teams.api's AdaptiveCardActionResponse
 * union has no void/empty variant, so *some* body is required even though the real confirmation
 * already went out as a normal conversation activity (see sendReplies below).
 */
const ACTIVITY_MESSAGE_RESPONSE_TYPE = 'application/vnd.microsoft.activity.message' as const;

/**
 * A minimal, SDK-agnostic shape for whatever `app.on('message', ...)` hands us. Kept separate
 * from the real Teams SDK activity type so `handleActivity` below can be unit-tested without
 * constructing an SDK object — the whole point of confining the SDK import to this file. The
 * parameter is deliberately `any`: the real `send` overloads accept SDK-specific activity
 * shapes, and this file only ever passes it a plain string or a `{ type: 'typing' }` literal.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SendFn = (activity: any) => Promise<unknown>;

/**
 * Sends each reply by kind (spec §5): a card goes out as an Adaptive Card attachment and a text
 * reply goes out as-is. The one place both the message handler and the Refresh invoke handler
 * turn `Reply[]` into actual sends, so they can never diverge on how a card is packaged.
 *
 * The card activity deliberately carries NO `text`. An earlier version set it to
 * `reply.fallbackText` as a fallback for clients that cannot render cards, but Teams renders
 * `text` AND `attachments` together, so the user read the whole answer twice -- confirmed in the
 * M365 Agents Playground, which uses the same rendering engine. `fallbackText` is still
 * load-bearing: the catch below resends it as plain text if the attachment is rejected, which is
 * the real coverage for a client that cannot take the card. Do not reintroduce `text` here.
 */
async function sendReplies(send: SendFn, replies: readonly Reply[]): Promise<void> {
  for (const reply of replies) {
    if (reply.kind === 'card') {
      try {
        await send({
          type: 'message',
          attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: reply.card }],
        });
      } catch (err) {
        // A rejected card attachment must not cost the user their answer (spec §7): every answer
        // now carries one, so this is newly probable, not a corner case. Retry once as plain
        // text carrying the same fallbackText the card would have shown; if THAT also throws,
        // propagate it exactly as before this fix -- the caller's existing outer handling
        // (handleActivity/handleCardAction's try/catch around the pipeline call) is what turns an
        // unexpected failure into UNEXPECTED_ERROR_REPLY (review finding: Minor 7).
        console.error('Falha ao enviar o card, tentando novamente como texto simples:', err);
        await send(reply.fallbackText);
      }
    } else {
      await send(reply.text);
    }
  }
}

/**
 * The testable core of the message handler: never goes silent (spec §8) and never lets a
 * failure in the typing indicator swallow the reply.
 */
export async function handleActivity(
  send: SendFn,
  rawText: string | undefined,
  mentions: readonly MentionLike[],
  conversationId: string,
  conversationType: string | undefined,
  userId: string,
  deps: HandleDeps,
): Promise<void> {
  const text = stripMentions(rawText ?? '', mentions).trim();
  if (text === '') {
    // An attachment- or image-only message has no text at all. Going silent here reads as a
    // broken bot (spec §8); tell the user what we need instead.
    await send(NO_TEXT_RECEIVED);
    return;
  }

  try {
    await send({ type: 'typing' });
  } catch (err) {
    // The typing indicator is a nicety, not a dependency. The M365 Agents Playground does not
    // support it at all (spec §2) and would otherwise reject this send, throw here, and skip
    // handleMessage entirely -- silencing every single reply. Log and move on.
    console.error('Indicador de digitação falhou:', err);
  }

  let replies: Reply[];
  try {
    // Serialized per conversation (review findings: Important 1 & 2): `resolveSlots` reads the
    // binding store at entry and `ask()` writes it back only after `answerFn` returns, so two
    // overlapping calls for the same conversation would otherwise race on the same slot(s) --
    // either a `voltar` racing an in-flight `ask` on the personal slot, or two people's questions
    // against the shared binding losing one exchange to a last-write-wins `set`. This trades a
    // little latency (a second person's message waits for the first to finish being stored) for
    // correctness, which is the right trade inside a single thread. `handleMessage` itself stays
    // free of this mechanism so it remains a pure pipeline (see serialize.ts).
    replies = await runExclusive(conversationId, () =>
      handleMessage({ text, conversationId, conversationType, userId }, deps));
  } catch (err) {
    // handleMessage already converts expected failures into pt-BR replies; reaching here means
    // an unexpected bug. The user gets an apology, the detail goes to the server log.
    console.error('handleMessage falhou:', err);
    replies = [{ kind: 'text', text: UNEXPECTED_ERROR_REPLY }];
  }

  await sendReplies(send, replies);
}

/**
 * Reply for any Action.Execute invoke whose verb is not the known Refresh or Select verb (spec §7, review
 * finding: Minor 5). The SDK's CARD_ACTION_ROUTE dispatches EVERY Action.Execute here regardless
 * of verb, and until this fix the handler never read the verb at all -- harmless with exactly one
 * button, but silently treating any future second button's press as Refresh the moment one ships.
 * Names what the bot understood rather than the unrecognised verb, per spec §7's wording.
 */
export const UNKNOWN_INVOKE_ACTION_REPLY =
  'Não reconheço essa ação. Por aqui sei executar "Atualizar" (buscar os dados mais recentes do card) '
  + 'e a seleção de card dos resultados de busca.';

/**
 * Executes a card-action handler with per-conversation serialization and never-silent error handling.
 * Shared by Refresh and Select invoke handlers to avoid duplicating the try/catch + runExclusive +
 * sendReplies pattern.
 */
async function runCardReplies(
  send: SendFn,
  conversationId: string,
  fn: () => Promise<Reply[]>,
): Promise<void> {
  let replies: Reply[];
  try {
    // Per-conversation serialization: button presses and concurrent text messages must not race
    // on the same binding slot (review findings: Important 1 & 2).
    replies = await runExclusive(conversationId, fn);
  } catch (err) {
    // The handler already converts expected failures into pt-BR replies; reaching here means
    // an unexpected bug. The user gets an apology, the detail goes to the server log.
    console.error('Erro inesperado no card-action:', err);
    replies = [{ kind: 'text', text: UNEXPECTED_ERROR_REPLY }];
  }

  await sendReplies(send, replies);
}

/**
 * The testable core of the Refresh and Select invoke handlers (spec §6): mirrors handleActivity's
 * never-goes-silent guarantee (spec §8) for the button path. Routes on the verb extracted from the
 * invoke activity; the verb check itself is covered by this file's offline tests rather than living
 * un-testably inside the SDK callback (review finding: Minor 5).
 *
 * `data` carries the action payload (e.g. the selected card's system and id); handleSelect validates it.
 */
export async function handleCardAction(
  send: SendFn,
  verb: string | undefined,
  data: unknown,
  conversationId: string,
  conversationType: string | undefined,
  userId: string,
  deps: HandleDeps,
): Promise<void> {
  if (verb === REFRESH_ACTION) {
    await runCardReplies(send, conversationId, () =>
      handleRefresh({ conversationId, conversationType, userId }, deps));
    return;
  }

  if (verb === SELECT_ACTION) {
    await runCardReplies(send, conversationId, () =>
      handleSelect({ conversationId, conversationType, userId }, data, deps));
    return;
  }

  await send(UNKNOWN_INVOKE_ACTION_REPLY);
}

/**
 * Maps our SDK-free option shape onto the SDK's own `AppOptions` type (review finding: Minor 7).
 * `new App(appOptionsForAuthMode(authMode))` passes a variable, and TypeScript's excess-property
 * checking only fires on object literals -- so if the SDK ever renamed e.g. `clientId`, that call
 * would keep compiling while silently dropping the option at runtime. The guard below fails to
 * compile instead when that happens.
 *
 * `TeamsAppAuthOptions` is a two-member union (the authenticated shape and the unauthenticated
 * shape). Plain `keyof TeamsAppAuthOptions` would resolve to the INTERSECTION of the members'
 * keys -- here, only `dangerouslyAllowUnauthenticatedRequests` -- silently missing a rename of
 * `clientId`, `clientSecret` or `tenantId`. `KeysOfUnion` distributes over the union first (the
 * `T extends unknown` trick) so every member's keys are collected before comparing against
 * `AppOptions`, covering all four keys.
 */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type UnknownSdkOptionKeys = Exclude<KeysOfUnion<TeamsAppAuthOptions>, keyof AppOptions<IPlugin>>;
// Compile-time proof that every option key we hand the SDK still exists in AppOptions: if the SDK
// renames or removes one (clientId, clientSecret, tenantId, or the dangerous flag), this
// assignment fails to typecheck, naming the orphaned key(s) as the error. This only proves the
// KEYS still exist -- it does not catch a value-type change (e.g. clientId becoming a number);
// that is separately caught by ordinary assignability at the `new App(...)` call below.
const _sdkOptionKeysExist: UnknownSdkOptionKeys extends never ? true : UnknownSdkOptionKeys = true;
void _sdkOptionKeysExist;

function toSdkAppOptions(authMode: AuthMode): AppOptions<IPlugin> {
  return appOptionsForAuthMode(authMode);
}

/**
 * The ONLY file that imports the Teams SDK. Everything it does is: pull the conversation key and
 * text off the activity and delegate to handleActivity. Keeping it this thin is what lets the
 * whole pipeline be tested with no SDK and no network.
 *
 * Auth is decided by resolveAuthMode (src/teams/authMode.ts) at startup, fail-closed, and handed
 * in here as an AuthMode -- this file only maps it onto explicit App options. Unauthenticated
 * mode is for the local M365 Agents Playground only; it must never be reachable on a host without
 * the operator having set ALLOW_UNAUTHENTICATED=true on purpose.
 */
export function createTeamsApp(deps: HandleDeps, authMode: AuthMode): App {
  const app = new App(toSdkAppOptions(authMode));

  app.on('message', async ({ send, activity }) => {
    // Only the bot's own mention is stripped (review finding: Minor 4): `@bot o @André validou?`
    // must keep André's mention text intact, or the parsed question comes out mangled
    // ("o validou?"). `activity.recipient.id` is the bot's own account id on every activity.
    const mentions = botMentions(
      (activity.entities ?? []) as Array<{ type?: string; text?: string; mentioned?: { id?: string } }>,
      activity.recipient?.id,
    );

    await handleActivity(
      send,
      activity.text,
      mentions,
      activity.conversation.id,
      // The SDK types this field as a "LiteralUnion" (`'personal' | 'groupChat' | Omit<string,
      // ...>`) purely for editor autocomplete; at runtime it is always a plain string, so this
      // is a type-only widening, not a behavior change.
      activity.conversation.conversationType as string,
      activity.from?.id ?? '',
      deps,
    );
  });

  // Card action buttons (spec §6): Refresh button on answer cards and select buttons on candidate
  // cards. CARD_ACTION_ROUTE is confirmed against the installed SDK (@microsoft/teams.apps 2.0.15):
  // router.js dispatches ANY Action.Execute invoke to this route name regardless of the pressed
  // button's `verb` -- this is not the brief's unverified guess, it is what the package actually does.
  app.on(CARD_ACTION_ROUTE, async ({ send, activity }) => {
    // The invoke's verb and data live at value.action.verb and value.action.data (AdaptiveCardInvokeValue.action
    // per @microsoft/teams.api) -- this route previously never read the verb at all (review finding:
    // Minor 5), so any Action.Execute silently ran Refresh regardless of which button sent it.
    const action = (activity as { value?: { action?: { verb?: string; data?: unknown } } }).value?.action;
    const verb = action?.verb;
    const data = action?.data;

    await handleCardAction(
      send,
      verb,
      data,
      activity.conversation.id,
      activity.conversation.conversationType as string,
      activity.from?.id ?? '',
      deps,
    );

    return { statusCode: 200, type: ACTIVITY_MESSAGE_RESPONSE_TYPE, value: '' };
  });

  return app;
}

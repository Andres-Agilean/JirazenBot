import { App } from '@microsoft/teams.apps';
import { handleMessage, handleRefresh, NO_TEXT_RECEIVED, type HandleDeps } from './handleMessage.js';
import { stripMentions, type MentionLike } from './mentions.js';
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
 * Sends each reply by kind (spec §5): a card goes out as an Adaptive Card attachment with the
 * plain-text fallback on the activity's `text` (for clients that cannot render cards); a text
 * reply goes out as-is. The one place both the message handler and the Refresh invoke handler
 * turn `Reply[]` into actual sends, so they can never diverge on how a card is packaged.
 */
async function sendReplies(send: SendFn, replies: readonly Reply[]): Promise<void> {
  for (const reply of replies) {
    if (reply.kind === 'card') {
      await send({
        type: 'message',
        text: reply.fallbackText,
        attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: reply.card }],
      });
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
    replies = await handleMessage({ text, conversationId, conversationType, userId }, deps);
  } catch (err) {
    // handleMessage already converts expected failures into pt-BR replies; reaching here means
    // an unexpected bug. The user gets an apology, the detail goes to the server log.
    console.error('handleMessage falhou:', err);
    replies = [{ kind: 'text', text: UNEXPECTED_ERROR_REPLY }];
  }

  await sendReplies(send, replies);
}

/**
 * The testable core of the Refresh invoke handler (spec §6): mirrors handleActivity's
 * never-goes-silent guarantee (spec §8) for the button path. Without this, an unexpected
 * failure inside handleRefresh (e.g. the store rejecting) would leave the invoke callback
 * rejecting -- nothing sent, no apology, and the user pressing Atualizar into silence.
 */
export async function handleCardAction(
  send: SendFn,
  conversationId: string,
  conversationType: string | undefined,
  userId: string,
  deps: HandleDeps,
): Promise<void> {
  let replies: Reply[];
  try {
    replies = await handleRefresh({ conversationId, conversationType, userId }, deps);
  } catch (err) {
    // handleRefresh already converts expected failures into pt-BR replies; reaching here means
    // an unexpected bug. The user gets an apology, the detail goes to the server log.
    console.error('handleRefresh falhou:', err);
    replies = [{ kind: 'text', text: UNEXPECTED_ERROR_REPLY }];
  }

  await sendReplies(send, replies);
}

/**
 * The ONLY file that imports the Teams SDK. Everything it does is: pull the conversation key and
 * text off the activity and delegate to handleActivity. Keeping it this thin is what lets the
 * whole pipeline be tested with no SDK and no network.
 *
 * dangerouslyAllowUnauthenticatedRequests is correct for local Playground use only; a hosted
 * deployment must remove it. (The plan's `skipAuth` is deprecated in SDK 2.0.15 in favor of
 * this name.)
 */
export function createTeamsApp(deps: HandleDeps): App {
  const app = new App({ dangerouslyAllowUnauthenticatedRequests: true });

  app.on('message', async ({ send, activity }) => {
    const mentions: MentionLike[] = ((activity.entities ?? []) as Array<{ type?: string; text?: string }>)
      .filter((e) => e.type === 'mention')
      .map((e) => ({ text: e.text ?? '' }));

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

  // The Refresh button on an answer card (spec §6). CARD_ACTION_ROUTE is confirmed against the
  // installed SDK (@microsoft/teams.apps 2.0.15): router.js dispatches ANY Action.Execute invoke
  // to this route name regardless of the pressed button's `verb` -- this is not the brief's
  // unverified guess, it is what the package actually does.
  app.on(CARD_ACTION_ROUTE, async ({ send, activity }) => {
    await handleCardAction(
      send,
      activity.conversation.id,
      activity.conversation.conversationType as string,
      activity.from?.id ?? '',
      deps,
    );

    return { statusCode: 200, type: ACTIVITY_MESSAGE_RESPONSE_TYPE, value: '' };
  });

  return app;
}

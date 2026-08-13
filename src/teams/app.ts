import { App } from '@microsoft/teams.apps';
import { handleMessage, NO_TEXT_RECEIVED, type HandleDeps } from './handleMessage.js';
import { stripMentions, type MentionLike } from './mentions.js';

const UNEXPECTED_ERROR_REPLY = 'Algo deu errado do meu lado. Tente novamente em instantes.';

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

  let replies: string[];
  try {
    replies = await handleMessage({ text, conversationId, conversationType, userId }, deps);
  } catch (err) {
    // handleMessage already converts expected failures into pt-BR replies; reaching here means
    // an unexpected bug. The user gets an apology, the detail goes to the server log.
    console.error('handleMessage falhou:', err);
    replies = [UNEXPECTED_ERROR_REPLY];
  }

  for (const reply of replies) {
    await send(reply);
  }
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

  return app;
}

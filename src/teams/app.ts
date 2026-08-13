import { App } from '@microsoft/teams.apps';
import { handleMessage, type HandleDeps } from './handleMessage.js';

/**
 * The ONLY file that imports the Teams SDK. Everything it does is: pull the conversation key and
 * text off the activity, show a typing indicator, delegate to handleMessage, and send what comes
 * back. Keeping it this thin is what lets the whole pipeline be tested with no SDK and no network.
 *
 * dangerouslyAllowUnauthenticatedRequests is correct for local Playground use only; a hosted
 * deployment must remove it. (The plan's `skipAuth` is deprecated in SDK 2.0.15 in favor of
 * this name.)
 */
export function createTeamsApp(deps: HandleDeps): App {
  const app = new App({ dangerouslyAllowUnauthenticatedRequests: true });

  app.on('message', async ({ send, activity }) => {
    const text = (activity.text ?? '').trim();
    if (text === '') return;

    await send({ type: 'typing' });

    let replies: string[];
    try {
      replies = await handleMessage(text, activity.conversation.id, deps);
    } catch (err) {
      // handleMessage already converts expected failures into pt-BR replies; reaching here means
      // an unexpected bug. The user gets an apology, the detail goes to the server log.
      console.error('handleMessage falhou:', err);
      replies = ['Algo deu errado do meu lado. Tente novamente em instantes.'];
    }

    for (const reply of replies) {
      await send(reply);
    }
  });

  return app;
}

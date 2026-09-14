import 'dotenv/config';
import { loadConfig } from '@/config.js';
import { createTeamsApp } from '@/teams/app.js';
import { resolveAuthMode, type AuthMode } from '@/teams/authMode.js';
import { InMemoryBindingStore } from '@/teams/bindings.js';
import { loadCardBundle } from '@/bundle/load.js';
import { answer } from '@/claude/answer.js';
import { createAnthropicClient } from '@/claude/client.js';
import type { HandleDeps } from '@/teams/handleMessage.js';

const DEFAULT_PORT = 3978;

const cfg = loadConfig();

let authMode: AuthMode;
try {
  authMode = resolveAuthMode(cfg);
} catch (err) {
  // resolveAuthMode's failures are already pt-BR messages meant for the operator's terminal
  // (review finding: Minor 5). Left uncaught, Node prints the message buried inside a stack
  // trace; this surfaces just the message and exits cleanly instead.
  console.error((err as Error).message);
  process.exit(1);
}

const client = createAnthropicClient(cfg);

const deps: HandleDeps = {
  store: new InMemoryBindingStore(),
  loadBundle: (ref, surface) => loadCardBundle(ref, cfg, surface),
  answerFn: (bundle, question, history) =>
    answer(bundle, question, history, {
      client,
      model: cfg.claudeModel,
      maxTokens: cfg.claudeMaxTokens,
    }),
  cfg,
  now: Date.now,
};

const port = Number(process.env.PORT ?? DEFAULT_PORT);
await createTeamsApp(deps, authMode).start(port);
console.log(
  authMode.mode === 'authenticated'
    ? 'Modo autenticado: validação de token do Bot Framework ativa.'
    : 'Modo NÃO autenticado (ALLOW_UNAUTHENTICATED=true): somente uso local com o Playground. Não exponha esta porta.',
);
console.log(`Bot ouvindo em http://localhost:${port}/api/messages`);
console.log(`Playground: agentsplayground -e http://localhost:${port}/api/messages --channel-id msteams`);

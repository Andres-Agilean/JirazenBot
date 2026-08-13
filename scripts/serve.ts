import 'dotenv/config';
import { loadConfig } from '@/config.js';
import { createTeamsApp } from '@/teams/app.js';
import { InMemoryBindingStore } from '@/teams/bindings.js';
import { SURFACE } from '@/teams/surface.js';
import { loadCardBundle } from '@/bundle/load.js';
import { answer } from '@/claude/answer.js';
import { createAnthropicClient } from '@/claude/client.js';
import type { HandleDeps } from '@/teams/handleMessage.js';

const DEFAULT_PORT = 3978;

const cfg = loadConfig();
const client = createAnthropicClient(cfg);

const deps: HandleDeps = {
  store: new InMemoryBindingStore(),
  loadBundle: (ref) => loadCardBundle(ref, cfg, SURFACE),
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
await createTeamsApp(deps).start(port);
console.log(`Bot ouvindo em http://localhost:${port}/api/messages`);
console.log(`Playground: agentsplayground -e http://localhost:${port}/api/messages -c emulator`);

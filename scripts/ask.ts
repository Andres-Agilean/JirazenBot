import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { loadCardBundle } from '../src/bundle/load.js';
import { answer } from '../src/claude/answer.js';
import { createAnthropicClient } from '../src/claude/client.js';
import { parseCardArgs } from './parseCardArgs.js';
import { splitReferenceAndQuestion } from './splitReference.js';

const EXIT_NOT_FOUND_OR_AMBIGUOUS = 1;
const EXIT_BAD_USAGE = 2;
const USAGE = 'Uso: npm run ask -- <PROJ-123 | chamado 4471 | URL> "<pergunta>" [--surface dm|multiparty]';

const parsed = parseCardArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(USAGE);
  process.exitCode = EXIT_BAD_USAGE;
} else {
  const cfg = loadConfig();
  const split = splitReferenceAndQuestion(parsed.args.refText, cfg.allowedProjects);

  if (!split) {
    console.error(USAGE);
    process.exitCode = EXIT_BAD_USAGE;
  } else {
    const { ref, question } = split;
    const result = await loadCardBundle(ref, cfg, parsed.args.surface);
    if (result.status === 'ambiguous') {
      console.error(`Referência ambígua (${result.side}): ${result.candidates.join(', ')}`);
      process.exitCode = EXIT_NOT_FOUND_OR_AMBIGUOUS;
    } else if (result.status === 'not_found') {
      console.error(result.message);
      process.exitCode = EXIT_NOT_FOUND_OR_AMBIGUOUS;
    } else {
      const client = createAnthropicClient(cfg);
      const a = await answer(result.bundle, question, [], {
        client,
        model: cfg.claudeModel,
        maxTokens: cfg.claudeMaxTokens,
      });
      console.log(a.text);
      console.error(
        `\n[${a.model} | entrada ${a.usage.input} | saída ${a.usage.output} | ` +
          `cache lido ${a.usage.cacheRead} | cache escrito ${a.usage.cacheWrite}]`,
      );
    }
  }
}

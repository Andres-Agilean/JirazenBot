import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { parseReference } from '../src/resolve/parseReference.js';
import { loadCardBundle } from '../src/bundle/load.js';
import { answer } from '../src/claude/answer.js';
import { createAnthropicClient } from '../src/claude/client.js';
import { parseCardArgs } from './parseCardArgs.js';

const EXIT_NOT_FOUND_OR_AMBIGUOUS = 1;
const EXIT_BAD_USAGE = 2;
const USAGE = 'Uso: npm run ask -- <PROJ-123 | chamado 4471 | URL> "<pergunta>" [--surface dm|multiparty]';

const parsed = parseCardArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(USAGE);
  process.exitCode = EXIT_BAD_USAGE;
} else {
  // parseCardArgs joins every non-flag argument into a single args.refText, so the boundary
  // between the reference and the trailing quoted question is lost. Recover it by growing the
  // leading word-run one word at a time and stopping at the first prefix parseReference accepts
  // ("QZ-252" is one word, "chamado 16467" is two). Growing from the SHORTEST prefix up matters:
  // parseReference's patterns are unanchored (e.g. KEYWORD_TICKET, ISSUE_KEY) and match a
  // reference anywhere inside the text they're given, so a longer prefix that merely *contains*
  // a valid reference would also "match" -- checked shortest-first, that would swallow the whole
  // question as part of the reference and leave nothing for the question.
  const words = parsed.args.refText.trim().split(/\s+/);
  let ref = null;
  let refWordCount = 0;
  const cfg = loadConfig();
  for (let n = 1; n <= words.length; n++) {
    const candidate = parseReference(words.slice(0, n).join(' '), cfg.allowedProjects);
    if (candidate) {
      ref = candidate;
      refWordCount = n;
      break;
    }
  }
  const question = words.slice(refWordCount).join(' ').trim();

  if (!ref || question === '') {
    console.error(USAGE);
    process.exitCode = EXIT_BAD_USAGE;
  } else {
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

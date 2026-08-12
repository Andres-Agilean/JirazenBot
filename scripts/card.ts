import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { parseReference } from '../src/resolve/parseReference.js';
import { loadCardBundle } from '../src/bundle/load.js';
import { renderBundle } from '../src/bundle/render.js';
import { parseCardArgs } from './parseCardArgs.js';

// Exit codes for this CLI. We set `process.exitCode` and let Node exit naturally once the event
// loop drains, rather than calling `process.exit()` -- calling process.exit() while a
// console.error write to a Windows console handle is still in flight crashes the process
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`).
const EXIT_USAGE_ERROR = 2;
const EXIT_NOT_FOUND_OR_AMBIGUOUS = 1;

const parsedArgs = parseCardArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
  console.error(`Uso: npm run card -- <PROJ-123 | chamado 4471 | URL> [--surface dm|multiparty]\n${parsedArgs.error}`);
  process.exitCode = EXIT_USAGE_ERROR;
} else {
  const { refText, surface } = parsedArgs.args;

  const cfg = loadConfig();
  const ref = parseReference(refText, cfg.allowedProjects);
  if (!ref) {
    console.error('Uso: npm run card -- <PROJ-123 | chamado 4471 | URL> [--surface dm|multiparty]');
    process.exitCode = EXIT_USAGE_ERROR;
  } else {
    const result = await loadCardBundle(ref, cfg, surface);

    if (result.status === 'ok') {
      console.log(renderBundle(result.bundle));
    } else if (result.status === 'ambiguous') {
      console.error(`Referência ambígua (${result.side}): ${result.candidates.join(', ')}`);
      process.exitCode = EXIT_NOT_FOUND_OR_AMBIGUOUS;
    } else {
      console.error(result.message);
      process.exitCode = EXIT_NOT_FOUND_OR_AMBIGUOUS;
    }
  }
}

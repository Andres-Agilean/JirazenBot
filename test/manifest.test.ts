import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COMMANDS } from '@/teams/commands.js';

// Guards against the Teams app manifest and src/teams/commands.ts drifting apart (review finding:
// Minor 4). appPackage/manifest.json hardcodes command titles as plain strings -- nothing ties
// them to COMMANDS, so a rename of ATUALIZAR_COMMAND (or a typo in either place) would compile and
// pass every other test while the manifest's command titles quietly stopped matching what
// parseCommand actually accepts. Reads the file directly (fs + JSON.parse, no import assertion,
// no network) so this stays offline like every other test.
describe('appPackage/manifest.json commands', () => {
  it('every command title is a known command constant from src/teams/commands.ts', () => {
    const rootDir = fileURLToPath(new URL('..', import.meta.url));
    const manifest = JSON.parse(
      readFileSync(path.join(rootDir, 'appPackage', 'manifest.json'), 'utf-8'),
    );

    const titles: string[] = manifest.bots[0].commandLists[0].commands.map(
      (command: { title: string }) => command.title,
    );

    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(COMMANDS as readonly string[]).toContain(title);
    }
  });
});

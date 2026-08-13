import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vitestConfig from '../vitest.config.js';

// Guards against tsconfig.json and vitest.config.ts silently disagreeing on
// where the `@/` alias points. If they drift, one resolver keeps working
// while the other fails in a confusing way (types resolve but tests don't,
// or vice versa).
describe('@/ path alias', () => {
  it('tsconfig.json paths and vitest.config.ts resolve.alias point at the same directory', () => {
    const rootDir = fileURLToPath(new URL('..', import.meta.url));

    const tsconfig = JSON.parse(readFileSync(path.join(rootDir, 'tsconfig.json'), 'utf-8'));
    const tsconfigPaths: string[] | undefined = tsconfig.compilerOptions?.paths?.['@/*'];
    expect(tsconfigPaths).toBeDefined();
    const tsconfigTarget = path.resolve(rootDir, tsconfigPaths![0].replace(/\/\*$/, ''));

    const alias = vitestConfig.resolve?.alias;
    const vitestAliasTarget = Array.isArray(alias)
      ? alias.find((entry) => entry.find === '@')?.replacement
      : (alias as Record<string, string> | undefined)?.['@'];
    expect(vitestAliasTarget).toBeDefined();
    const vitestTarget = path.resolve(vitestAliasTarget as string);

    expect(vitestTarget).toBe(tsconfigTarget);
  });
});

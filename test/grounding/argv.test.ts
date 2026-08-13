import { describe, expect, it } from 'vitest';
import { parseOnly } from './argv.js';

describe('parseOnly', () => {
  it('returns null when --only is absent -- run every case', () => {
    expect(parseOnly(['node', 'run.ts'])).toBeNull();
    expect(parseOnly(['node', 'run.ts', '--judge'])).toBeNull();
  });

  it('returns the value when --only is followed by a case id', () => {
    expect(parseOnly(['node', 'run.ts', '--only', 'nib-04'])).toBe('nib-04');
  });

  it('returns undefined when --only is the last argv entry (no value at all)', () => {
    // This is the bug: process.argv[i + 1] being undefined must not be treated as "no filter".
    expect(parseOnly(['node', 'run.ts', '--only'])).toBeUndefined();
  });

  it('returns undefined when the token after --only is itself a flag', () => {
    expect(parseOnly(['node', 'run.ts', '--only', '--judge'])).toBeUndefined();
  });
});

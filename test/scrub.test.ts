import { describe, expect, it } from 'vitest';
import { scrubEmails } from '../src/fetch/scrub.js';

describe('scrubEmails', () => {
  it('replaces emails at any depth, leaving structure intact', () => {
    const input = {
      reporter: 'caio.moreira@example.com',
      nested: { text: 'contato: fulano.tal@example.com, ok?' },
      list: ['a@b.co', 42, null],
    };
    expect(scrubEmails(input)).toEqual({
      reporter: 'user@example.com',
      nested: { text: 'contato: user@example.com, ok?' },
      list: ['user@example.com', 42, null],
    });
  });
});

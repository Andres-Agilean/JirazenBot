import { describe, expect, it } from 'vitest';
import { parseCommand } from '@/teams/commands.js';

describe('parseCommand', () => {
  it.each(['ajuda', 'Ajuda', 'AJUDA', '  ajuda  '])('recognizes %s', (text) => {
    expect(parseCommand(text)).toBe('ajuda');
  });

  it.each(['atualizar', 'Atualizar', 'ATUALIZAR'])('recognizes %s', (text) => {
    expect(parseCommand(text)).toBe('atualizar');
  });

  it('only matches the whole message, never a word inside a question', () => {
    expect(parseCommand('preciso de ajuda com esse card')).toBeNull();
    expect(parseCommand('quando vão atualizar o status?')).toBeNull();
  });

  it('returns null for anything else', () => {
    expect(parseCommand('QZ-252')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

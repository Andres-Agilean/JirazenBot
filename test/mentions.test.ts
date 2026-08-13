import { describe, expect, it } from 'vitest';
import { stripMentions } from '@/teams/mentions.js';

const BOT = [{ text: '<at>Agilean Bot</at>' }];

describe('stripMentions', () => {
  it('removes a leading bot mention and the space after it', () => {
    expect(stripMentions('<at>Agilean Bot</at> QZ-252', BOT)).toBe('QZ-252');
  });

  it('removes a mention anywhere in the message', () => {
    expect(stripMentions('QZ-252 <at>Agilean Bot</at> quem validou?', BOT)).toBe(
      'QZ-252 quem validou?',
    );
  });

  it('removes several mentions', () => {
    const two = [{ text: '<at>Agilean Bot</at>' }, { text: '<at>Ana</at>' }];
    expect(stripMentions('<at>Ana</at> pergunta pro <at>Agilean Bot</at> QZ-252', two)).toBe(
      'pergunta pro QZ-252',
    );
  });

  it('is a no-op when there are no mentions', () => {
    expect(stripMentions('QZ-252 quem validou?', [])).toBe('QZ-252 quem validou?');
  });

  it('collapses the whitespace a removed mention leaves behind', () => {
    expect(stripMentions('  <at>Agilean Bot</at>   QZ-252  ', BOT)).toBe('QZ-252');
  });

  it('leaves a message that is only a mention as empty, not as stray markup', () => {
    expect(stripMentions('<at>Agilean Bot</at>', BOT)).toBe('');
  });

  it('does not treat mention text as a regex', () => {
    // A display name with regex metacharacters must not blow up or over-match.
    const odd = [{ text: '<at>C++ (Dev) [bot]</at>' }];
    expect(stripMentions('<at>C++ (Dev) [bot]</at> QZ-252', odd)).toBe('QZ-252');
  });
});

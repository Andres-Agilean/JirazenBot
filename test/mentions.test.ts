import { describe, expect, it } from 'vitest';
import { botMentions, stripMentions } from '@/teams/mentions.js';

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

describe('botMentions (review finding: Minor 4)', () => {
  it('keeps only the mention of the bot, dropping a mention of another person', () => {
    const entities = [
      { type: 'mention', text: '<at>Agilean Bot</at>', mentioned: { id: 'bot-1' } },
      { type: 'mention', text: '<at>André</at>', mentioned: { id: 'user-andre' } },
    ];
    expect(botMentions(entities, 'bot-1')).toEqual([{ text: '<at>Agilean Bot</at>' }]);
  });

  it('keeps a mention entity whose mentioned.id is missing, since there is no way to tell whose it is', () => {
    const entities = [{ type: 'mention', text: '<at>Mistério</at>' }];
    expect(botMentions(entities, 'bot-1')).toEqual([{ text: '<at>Mistério</at>' }]);
  });

  it('ignores entities that are not mentions at all', () => {
    const entities = [
      { type: 'clientInfo' },
      { type: 'mention', text: '<at>Agilean Bot</at>', mentioned: { id: 'bot-1' } },
    ];
    expect(botMentions(entities, 'bot-1')).toEqual([{ text: '<at>Agilean Bot</at>' }]);
  });

  it('drops the bots own mention when mentioned.id does not match, leaving nothing to strip', () => {
    const entities = [{ type: 'mention', text: '<at>Agilean Bot</at>', mentioned: { id: 'someone-else' } }];
    expect(botMentions(entities, 'bot-1')).toEqual([]);
  });

  it('combined with stripMentions, removes only the bots name from a message that also @mentions a person', () => {
    // The exact failure scenario from the finding: "@bot o @André validou?" must not become
    // "o validou?" -- André's own mention must survive so the parsed question still makes sense.
    const entities = [
      { type: 'mention', text: '<at>Agilean Bot</at>', mentioned: { id: 'bot-1' } },
      { type: 'mention', text: '<at>André</at>', mentioned: { id: 'user-andre' } },
    ];
    const mentions = botMentions(entities, 'bot-1');
    const text = stripMentions('<at>Agilean Bot</at> o <at>André</at> validou?', mentions);
    expect(text).toBe('o <at>André</at> validou?');
  });
});

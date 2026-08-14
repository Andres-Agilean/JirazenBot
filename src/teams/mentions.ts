/**
 * The minimal shape we need from a Teams mention entity. Deliberately NOT the SDK's type: this
 * module is imported by code that must stay SDK-free and offline-testable (spec §3).
 */
export interface MentionLike {
  text: string;
}

/**
 * The minimal shape we need from a raw Teams activity entity to pick out mentions of the bot
 * itself. Deliberately NOT the SDK's type, for the same reason as MentionLike above.
 */
export interface EntityLike {
  type?: string;
  text?: string;
  mentioned?: { id?: string };
}

const MENTION_ENTITY_TYPE = 'mention';

/**
 * Narrows an activity's raw entities down to mentions of the BOT ITSELF, by id (review finding:
 * Minor 4). Every entity of type 'mention' used to be stripped regardless of who it named, so
 * `@bot o @André validou?` became `o validou?` -- a mangled question, because André's own mention
 * was removed along with the bot's. Keeping the entity when `mentioned.id` is missing preserves
 * the prior fail-safe behaviour: better a stripped mention than the bot's display name surviving
 * into the parsed reference.
 */
export function botMentions(entities: readonly EntityLike[], botId: string | undefined): MentionLike[] {
  return entities
    .filter((e) => e.type === MENTION_ENTITY_TYPE)
    .filter((e) => e.mentioned?.id === undefined || e.mentioned.id === botId)
    .map((e) => ({ text: e.text ?? '' }));
}

/**
 * Teams delivers channel messages with the bot's mention inline as `<at>Display Name</at>`.
 * Left in place, the display name becomes part of the text `parseReference` sees, which breaks
 * reference parsing outright. Mentions are removed by exact substring match -- never by building
 * a regex from the display name, which would misbehave on names containing regex metacharacters.
 */
export function stripMentions(text: string, mentions: readonly MentionLike[]): string {
  let out = text;
  for (const mention of mentions) {
    if (!mention.text) continue;
    out = out.split(mention.text).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

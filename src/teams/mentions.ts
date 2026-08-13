/**
 * The minimal shape we need from a Teams mention entity. Deliberately NOT the SDK's type: this
 * module is imported by code that must stay SDK-free and offline-testable (spec §3).
 */
export interface MentionLike {
  text: string;
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

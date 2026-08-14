import type { Config } from '@/config.js';
import type { CardBundle } from '@/bundle/types.js';
import { renderGeneric } from '@/bundle/render.js';
import type { Binding } from './bindings.js';
import { ATUALIZAR_COMMAND } from './commands.js';
import { cardIdentity, collectedAt, jiraLink, zendeskLink } from './reply.js';

const ADAPTIVE_CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
const ADAPTIVE_CARD_VERSION = '1.5';

/** Appended to the header when the answer came from the reader's own split (spec §4/§5). */
export const PERSONAL_MARKER = '· sua consulta';

/**
 * A bracketed source citation the model emits inline, e.g. `[comentário jira 41713, André
 * Marques]` or `[descrição Jira]`. The negative lookahead skips `[text](url)` so a markdown link
 * is never mistaken for a citation.
 */
const CITATION = /\[([^\]\n]+)\](?!\()/g;

/**
 * Italicises the model's inline citations for display only.
 *
 * Deliberately done here rather than by changing the citation convention in `SYSTEM_PROMPT`: the
 * grounding eval's `mustCite` rules match on the exact bracketed form the model emits, so moving
 * the styling into the prompt would break those checks for a purely cosmetic gain. The model's
 * contract stays fixed; only what the reader sees changes.
 */
export function styleCitations(answerText: string): string {
  return answerText.replace(CITATION, '_[$1]_');
}

/**
 * The action id app.ts matches to route a Refresh invoke back through the atualizar path.
 * Derived from `ATUALIZAR_COMMAND` rather than a hand-written literal so the card's verb cannot
 * silently drift from what `parseCommand` accepts (Task 5 review finding).
 */
export const REFRESH_ACTION = ATUALIZAR_COMMAND;

/** The Jira API field id for status. `fields` is keyed by field ID, never by display label. */
const JIRA_STATUS_FIELD_ID = 'status';

/**
 * Jira status when the card has a Jira side, else the Zendesk status, else nothing.
 *
 * `fields.status` is a Jira object (`{ name: 'Em Teste', statusCategory: {...}, ... }`), not a
 * string, which is why this goes through `renderGeneric` — the same extraction the bundle
 * renderer already uses for every scalar field. Reading `fields.Status` would silently yield
 * `undefined` and produce a card with no status at all.
 */
export function cardStatus(bundle: CardBundle): string | null {
  const jiraStatus = renderGeneric(bundle.jira?.fields?.[JIRA_STATUS_FIELD_ID]);
  if (jiraStatus !== null && jiraStatus !== '') return jiraStatus;
  return bundle.zendesk?.status ?? null;
}

export function buildAnswerCard(
  answerText: string,
  binding: Binding,
  cfg: Config,
  opts: { personal?: boolean } = {},
): Record<string, unknown> {
  const { jira, zendesk } = binding.bundle;

  // Shared with the text footer so the key and ticket number are clickable here too. Emphasis
  // comes from the TextBlock's `weight` below rather than markdown bold, which would otherwise
  // have to nest inside the link.
  const identity = cardIdentity(binding.bundle, cfg);
  const header = opts.personal ? `${identity} ${PERSONAL_MARKER}` : identity;

  const status = cardStatus(binding.bundle);
  const subtitle = [status, `coletado às ${collectedAt(binding.bundle)}`]
    .filter(Boolean).join(' · ');

  const actions: Record<string, unknown>[] = [
    { type: 'Action.Execute', title: 'Atualizar', verb: REFRESH_ACTION, data: { action: REFRESH_ACTION } },
  ];
  if (jira) actions.push({ type: 'Action.OpenUrl', title: 'Jira', url: jiraLink(jira.issueKey, cfg) });
  if (zendesk) {
    actions.push({ type: 'Action.OpenUrl', title: 'Zendesk', url: zendeskLink(zendesk.ticketId, cfg) });
  }

  return {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    body: [
      { type: 'TextBlock', text: header, wrap: true, weight: 'Bolder' },
      { type: 'TextBlock', text: subtitle, wrap: true, isSubtle: true, spacing: 'None' },
      { type: 'TextBlock', text: styleCitations(answerText), wrap: true, separator: true },
    ],
    actions,
  };
}

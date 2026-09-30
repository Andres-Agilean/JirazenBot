import { normalizeText } from '@/text/normalize.js';
import type { CardBundle } from '@/bundle/types.js';
import type { DirectoryClientLike, DirectoryUser } from '@/msgraph/directory.js';
import { adaptiveCard, subtle } from './rundown.js';

/** Normalized whole-message command (spec §3); display copy keeps the accent. */
export const LEMBRAR_COMMAND = 'lembrar responsavel';
export const NOTE_MAX_CHARS = 280;
export const NOTE_TOO_LONG =
  `A nota é longa demais (limite de ${NOTE_MAX_CHARS} caracteres). Encurte e tente novamente.`;
export const REMINDER_NEEDS_CARD =
  'Para lembrar o responsável, primeiro abra um card (ex.: `QZ-252`) e envie `lembrar responsável`.';
export const NO_ASSIGNEE_REPLY = 'Este card não tem responsável no Jira, então não há quem lembrar.';

// Derive regex from LEMBRAR_COMMAND so they cannot drift
const [LEMBRAR_VERB, LEMBRAR_TARGET] = LEMBRAR_COMMAND.split(' ');
const LEMBRAR_RE = new RegExp(`^${LEMBRAR_VERB} (?:o )?${LEMBRAR_TARGET}\\s*(?::(.*))?$`);

export function parseLembrar(text: string): { note?: string; tooLong?: true } | null {
  // Normalize the command shell but slice the note from the ORIGINAL text so casing/accents survive.
  const normalized = normalizeText(text).replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, '').trim();
  const m = LEMBRAR_RE.exec(normalized);
  if (!m) return null;
  if (m[1] === undefined) return {};
  const colon = text.indexOf(':');
  const note = colon >= 0 ? text.slice(colon + 1).trim() : '';
  if (note === '') return null;
  if (note.length > NOTE_MAX_CHARS) return { note: undefined, tooLong: true };
  return { note };
}

/** The bound card's responsible person, as Jira renders it (same read as `src/fetch/jira.ts`). */
export function bundleAssignee(bundle: CardBundle): string | undefined {
  const assignee = bundle.jira?.fields.assignee as { displayName?: string } | null | undefined;
  return assignee?.displayName || undefined;
}

/** The bound card's one-line title for the confirmation: the Jira summary, else the Zendesk subject. */
export function bundleSummary(bundle: CardBundle): string {
  const summary = bundle.jira?.fields.summary;
  return typeof summary === 'string' && summary.trim() !== '' ? summary.trim() : (bundle.zendesk?.subject ?? '');
}

export const REMIND_SEND_ACTION = 'enviar-lembrete';
export const REMIND_CANCEL_ACTION = 'cancelar-lembrete';
export const REMIND_PICK_ACTION = 'escolher-lembrete';
export const REMINDER_CANDIDATE_CAP = 6;
export const NOT_IN_ORG = (name: string) => `Não encontrei "${name}" na organização.`;
export const UNCONFIGURED_DIRECTORY = 'Consulta ao diretório indisponível neste ambiente.';
/** A pick/send click whose card is no longer the bound one (binding expired or moved on; spec §5). */
export const REMINDER_EXPIRED = 'Este lembrete expirou. Peça novamente com `lembrar responsável`.';

export const REMINDER_SENT = (name: string): string => `Lembrete enviado para **${name}**.`;
export const REMINDER_SEND_FAILED =
  'Não consegui enviar o lembrete agora. Nada foi entregue — tente novamente em instantes.';
export const REMINDER_CANCELLED = 'Ok, nada foi enviado.';
export const UNCONFIGURED_SEND = 'Envio indisponível neste ambiente.';
/** The refreshed Jira assignee no longer matches the confirmed recipient: refuse rather than DM the wrong person (spec §1). */
export const REMINDER_REASSIGNED = 'O responsável deste card mudou desde a confirmação. Peça o lembrete novamente.';
/** Used when the Teams display name of the requester is unavailable. */
export const UNKNOWN_REQUESTER = 'Um colega';

/** The proactive-DM seam (spec §7): SDK-free here, implemented in src/teams/app.ts. */
export interface ReminderSenderLike { sendDm(userId: string, text: string): Promise<void> }

/** Fixed template (spec §6): user text appears ONLY inside the quoted note block. */
export function buildReminderDm(args: {
  requester: string; cardKey: string; summary: string; status: string | undefined; url: string; note?: string;
}): string {
  const lines = [
    `**${args.requester}** pediu um lembrete sobre o card [${args.cardKey}](${args.url}) — ${args.summary}.`,
    args.status ? `Status atual: ${args.status}.` : undefined,
    args.note ? `> ${args.note.replace(/\r?\n/g, ' ')}` : undefined,
    `Para tratar do assunto, responda diretamente a ${args.requester} — eu não encaminho respostas.`,
  ];
  return lines.filter(Boolean).join('\n\n');
}

const NO_MAIL = 'sem e-mail';

/** Every token of the shorter name appears among the longer name's tokens (middle names differ
 * between Jira and Entra — "João Silva" must match "João Carlos Silva" and vice versa). */
export function assigneeMatches(a: string, b: string): boolean {
  const ta = normalizeText(a).split(/\s+/).filter(Boolean);
  const tb = normalizeText(b).split(/\s+/).filter(Boolean);
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bag = new Set(big);
  return small.length > 0 && small.every((t) => bag.has(t));
}

/** Name-first resolution (spec §4): full name, then first token, filtered by token subset. */
export async function resolveAssignee(name: string, directory: DirectoryClientLike): Promise<DirectoryUser[]> {
  const seen = new Map<string, DirectoryUser>();
  const collect = (users: DirectoryUser[]) => {
    for (const u of users) {
      if (assigneeMatches(name, u.displayName) && !seen.has(u.id)) seen.set(u.id, u);
    }
  };
  collect(await directory.searchByName(name));
  if (seen.size === 0) {
    const first = name.split(/\s+/)[0];
    if (first && first !== name) collect(await directory.searchByName(first));
  }
  return [...seen.values()];
}

/** Button payload shared by pick and send: the resolved person, the card and the optional note. */
export interface ReminderPayload {
  userId: string;
  userName: string;
  userMail: string | null;
  cardKey: string;
  note?: string;
}

const reminderData = (action: string, user: DirectoryUser, cardKey: string, note: string | undefined) => ({
  action, userId: user.id, userName: user.displayName, userMail: user.mail, cardKey,
  ...(note !== undefined ? { note } : {}),
});

/**
 * Validates a pick/send payload like typed input (client data): non-blank strings for user and card,
 * a string-or-null mail, an optional string note. Anything else is null.
 */
export function parseReminderPayload(data: unknown): ReminderPayload | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const userId = str(d.userId);
  const userName = str(d.userName);
  const cardKey = str(d.cardKey);
  if (!userId || !userName || !cardKey) return null;
  if (d.userMail !== null && typeof d.userMail !== 'string') return null;
  if (d.note !== undefined && typeof d.note !== 'string') return null;
  return {
    userId, userName, userMail: (d.userMail as string | null), cardKey,
    ...(d.note !== undefined ? { note: d.note as string } : {}),
  };
}

const mailOf = (user: DirectoryUser): string => user.mail ?? NO_MAIL;
const cardTitle = (cardKey: string, summary: string): string => (summary ? `${cardKey} — ${summary}` : cardKey);
const confirmQuestion = (user: DirectoryUser, cardKey: string, summary: string): string =>
  `Enviar lembrete para **${user.displayName}** (${mailOf(user)}) sobre **${cardTitle(cardKey, summary)}**?`;
const noteLine = (note: string): string => `Nota: ${note}`;

/** Plain-text mirror of `buildReminderConfirmCard`. */
export function renderReminderConfirm(
  user: DirectoryUser, cardKey: string, summary: string, note: string | undefined,
): string {
  return [confirmQuestion(user, cardKey, summary), ...(note ? [noteLine(note)] : [])].join('\n\n');
}

/** Confirmation card (spec §5): nothing is sent until Enviar lembrete is clicked. */
export function buildReminderConfirmCard(
  user: DirectoryUser, cardKey: string, summary: string, note: string | undefined,
): Record<string, unknown> {
  return {
    ...adaptiveCard([
      { type: 'TextBlock', text: confirmQuestion(user, cardKey, summary), wrap: true },
      ...(note ? [subtle(noteLine(note))] : []),
    ]),
    actions: [
      {
        type: 'Action.Execute', title: 'Enviar lembrete', verb: REMIND_SEND_ACTION,
        data: reminderData(REMIND_SEND_ACTION, user, cardKey, note),
      },
      { type: 'Action.Execute', title: 'Cancelar', verb: REMIND_CANCEL_ACTION, data: { action: REMIND_CANCEL_ACTION } },
    ],
  };
}

const pickQuestion = (cardKey: string): string => `Qual destes é o responsável pelo ${cardKey}?`;
const pickLabel = (user: DirectoryUser): string => `${user.displayName} (${mailOf(user)})`;
const pickOverflow = (hidden: number): string => `e mais ${hidden} — refine o nome no Jira.`;

/** Plain-text mirror of `buildReminderPickCard`. */
export function renderReminderPick(users: DirectoryUser[], cardKey: string, _note: string | undefined): string {
  const shown = users.slice(0, REMINDER_CANDIDATE_CAP);
  const hidden = users.length - shown.length;
  return [pickQuestion(cardKey), ...shown.map((u) => `- ${pickLabel(u)}`), ...(hidden > 0 ? [pickOverflow(hidden)] : [])]
    .join('\n');
}

/** Clarification card (spec §4): one button per homonym (name + email), capped, overflow named. */
export function buildReminderPickCard(
  users: DirectoryUser[], cardKey: string, note: string | undefined,
): Record<string, unknown> {
  const shown = users.slice(0, REMINDER_CANDIDATE_CAP);
  const hidden = users.length - shown.length;
  return {
    ...adaptiveCard([
      { type: 'TextBlock', text: pickQuestion(cardKey), wrap: true },
      ...(hidden > 0 ? [subtle(pickOverflow(hidden))] : []),
    ]),
    actions: shown.map((u) => ({
      type: 'Action.Execute', title: pickLabel(u), verb: REMIND_PICK_ACTION,
      data: reminderData(REMIND_PICK_ACTION, u, cardKey, note),
    })),
  };
}

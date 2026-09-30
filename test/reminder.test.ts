import { describe, expect, it, vi } from 'vitest';
import {
  bundleAssignee, parseLembrar, NOTE_MAX_CHARS, resolveAssignee, buildReminderConfirmCard, buildReminderPickCard,
  renderReminderConfirm, renderReminderPick, REMIND_SEND_ACTION, REMIND_CANCEL_ACTION, REMIND_PICK_ACTION,
  REMINDER_CANDIDATE_CAP,
} from '@/teams/reminder.js';
import type { CardBundle } from '@/bundle/types.js';

describe('parseLembrar', () => {
  it.each(['lembrar responsável', 'lembrar responsavel', 'Lembrar o responsável', 'lembrar responsável!'])(
    'accepts %s with no note', (text) => expect(parseLembrar(text)).toEqual({}));
  it('captures the note after a colon, trimmed', () =>
    expect(parseLembrar('lembrar responsável: reunião amanhã às 10h')).toEqual({ note: 'reunião amanhã às 10h' }));
  it('keeps original casing/accents in the note', () =>
    expect(parseLembrar('lembrar responsavel: Reunião com o Sr. José')).toEqual({ note: 'Reunião com o Sr. José' }));
  it.each(['lembrar', 'lembrar o time', 'quero lembrar o responsável disso', 'responsável'])(
    'rejects %s (whole-message command only)', (text) => expect(parseLembrar(text)).toBeNull());
  it('rejects an empty note after the colon', () => expect(parseLembrar('lembrar responsável:  ')).toBeNull());
  it('flags an over-cap note as tooLong instead of matching', () =>
    expect(parseLembrar(`lembrar responsável: ${'x'.repeat(NOTE_MAX_CHARS + 1)}`)).toEqual({ note: undefined, tooLong: true }));
  it('tolerates a space before the colon', () =>
    expect(parseLembrar('lembrar responsável : nota')).toEqual({ note: 'nota' }));
  it('accepts a note of exactly NOTE_MAX_CHARS', () =>
    expect(parseLembrar(`lembrar responsável: ${'x'.repeat(NOTE_MAX_CHARS)}`)).toEqual({ note: 'x'.repeat(NOTE_MAX_CHARS) }));
  it('preserves colons inside the note', () =>
    expect(parseLembrar('lembrar responsável: reunião: sala 2')).toEqual({ note: 'reunião: sala 2' }));
});

const jiraBundle = (assignee: unknown): CardBundle => ({
  fetchedAt: '2026-09-30T12:00:00Z', surface: 'dm',
  jira: { issueId: '1', issueKey: 'QZ-1', fields: { summary: 'S', assignee }, comments: [], statusHistory: [] },
} as unknown as CardBundle);

describe('bundleAssignee', () => {
  it('reads displayName', () => expect(bundleAssignee(jiraBundle({ displayName: 'João Silva' }))).toBe('João Silva'));
  it('undefined for null assignee', () => expect(bundleAssignee(jiraBundle(null))).toBeUndefined());
  it('undefined for missing jira side', () =>
    expect(bundleAssignee({ fetchedAt: '', surface: 'dm' } as CardBundle)).toBeUndefined());
  it('undefined for empty displayName', () => expect(bundleAssignee(jiraBundle({ displayName: '' }))).toBeUndefined());
});

describe('resolveAssignee', () => {
  const dir = (byQuery: Record<string, { id: string; displayName: string; mail: string | null }[]>) => ({
    searchByName: async (q: string) => byQuery[q] ?? [],
  });
  it('matches accent-insensitively (Review Focus 1)', async () => {
    const users = await resolveAssignee('Joao Silva', dir({ 'Joao Silva': [], Joao: [{ id: '1', displayName: 'João Silva', mail: 'j@o.com' }] }));
    expect(users).toEqual([{ id: '1', displayName: 'João Silva', mail: 'j@o.com' }]);
  });
  it('full-name hit needs no fallback call', async () => {
    const spy = vi.fn(async (q: string) => (q === 'Ana Lima' ? [{ id: '2', displayName: 'Ana Lima', mail: null }] : []));
    expect(await resolveAssignee('Ana Lima', { searchByName: spy })).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('first-token fallback filters by token subset and dedupes by id', async () => {
    const ana = { id: '2', displayName: 'Ana Lima', mail: null };
    const users = await resolveAssignee('Ana Lima', dir({ 'Ana Lima': [], Ana: [ana, ana, { id: '3', displayName: 'Ana Souza', mail: null }] }));
    expect(users).toEqual([ana]);
  });
  it('middle names do not break the match (token subset, either direction)', async () => {
    const full = { id: '4', displayName: 'João Carlos Silva', mail: 'j@o.com' };
    expect(await resolveAssignee('Joao Silva', dir({ 'Joao Silva': [], Joao: [full] }))).toEqual([full]);
    const short = { id: '5', displayName: 'Ana Lima', mail: null };
    expect(await resolveAssignee('Ana Beatriz Lima', dir({ 'Ana Beatriz Lima': [], Ana: [short] }))).toEqual([short]);
  });
});

type CardActions = { actions: { verb: string; title: string; data: Record<string, unknown> }[] };

describe('reminder cards', () => {
  const user = { id: '1', displayName: 'João Silva', mail: 'joao@org.com' };
  it('confirm card names recipient, email, card and note, with Enviar/Cancelar verbs', () => {
    const card = JSON.stringify(buildReminderConfirmCard(user, 'QZ-1', 'Erro no relatório', 'reunião às 10h'));
    for (const s of ['João Silva', 'joao@org.com', 'QZ-1', 'Erro no relatório', 'reunião às 10h',
      REMIND_SEND_ACTION, REMIND_CANCEL_ACTION]) expect(card).toContain(s);
  });
  it('confirm card payload carries the resolved user, card key and note', () => {
    const card = buildReminderConfirmCard(user, 'QZ-1', 'S', 'n') as unknown as CardActions;
    expect(card.actions.find((a) => a.verb === REMIND_SEND_ACTION)?.data).toEqual({
      action: REMIND_SEND_ACTION, userId: '1', userName: 'João Silva', userMail: 'joao@org.com', cardKey: 'QZ-1', note: 'n',
    });
    expect(card.actions.find((a) => a.verb === REMIND_CANCEL_ACTION)?.data).toEqual({ action: REMIND_CANCEL_ACTION });
  });
  it('a null mail renders as "sem e-mail" in card and text mirrors', () => {
    const noMail = { id: '9', displayName: 'Ana', mail: null };
    expect(JSON.stringify(buildReminderConfirmCard(noMail, 'QZ-1', 'S', undefined))).toContain('sem e-mail');
    expect(renderReminderConfirm(noMail, 'QZ-1', 'S', undefined)).toContain('sem e-mail');
    expect(renderReminderPick([noMail], 'QZ-1', undefined)).toContain('sem e-mail');
  });
  it('text mirror carries the note only when there is one', () => {
    expect(renderReminderConfirm(user, 'QZ-1', 'S', 'reunião')).toContain('Nota: reunião');
    expect(renderReminderConfirm(user, 'QZ-1', 'S', undefined)).not.toContain('Nota:');
  });
  it('pick card caps candidates and names the overflow count (Review Focus 4)', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i), displayName: `João ${i}`, mail: null }));
    const card = buildReminderPickCard(many, 'QZ-1', undefined) as unknown as CardActions;
    expect(card.actions.filter((a) => a.verb === REMIND_PICK_ACTION)).toHaveLength(REMINDER_CANDIDATE_CAP);
    expect(JSON.stringify(card)).toContain('e mais 2');
    expect(renderReminderPick(many, 'QZ-1', undefined)).toContain('e mais 2');
  });
  it('pick payload carries user and card key', () => {
    const card = buildReminderPickCard([user], 'QZ-1', 'n') as unknown as CardActions;
    expect(card.actions[0]?.data).toEqual({
      action: REMIND_PICK_ACTION, userId: '1', userName: 'João Silva', userMail: 'joao@org.com', cardKey: 'QZ-1', note: 'n',
    });
  });
});

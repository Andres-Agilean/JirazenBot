import { describe, expect, it, vi } from 'vitest';
import {
  bundleAssignee, parseLembrar, NOTE_MAX_CHARS, resolveAssignee, buildReminderConfirmCard, buildReminderPickCard,
  renderReminderConfirm, renderReminderPick, REMIND_SEND_ACTION, REMIND_CANCEL_ACTION, REMIND_PICK_ACTION,
  REMINDER_CANDIDATE_CAP, buildReminderDm, assigneeMatches, parseReminderPayload,
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
    const card = JSON.stringify(buildReminderConfirmCard(user, 'QZ-1', 'Erro no relatório', 'reunião às 10h', 'n-1'));
    for (const s of ['João Silva', 'joao@org.com', 'QZ-1', 'Erro no relatório', 'reunião às 10h',
      REMIND_SEND_ACTION, REMIND_CANCEL_ACTION]) expect(card).toContain(s);
  });
  // Spec §5.1 shape change: buttons carry ONLY { action, nonce } -- the recipient, card and note live
  // in the server-side pending record, so none of them may appear in a payload any more.
  it('confirm card buttons carry only the action and the record nonce (spec §5.1)', () => {
    const card = buildReminderConfirmCard(user, 'QZ-1', 'S', 'n', 'nonce-1') as unknown as CardActions;
    expect(card.actions.find((a) => a.verb === REMIND_SEND_ACTION)?.data).toEqual({ action: REMIND_SEND_ACTION, nonce: 'nonce-1' });
    expect(card.actions.find((a) => a.verb === REMIND_CANCEL_ACTION)?.data).toEqual({ action: REMIND_CANCEL_ACTION, nonce: 'nonce-1' });
  });
  it('a null mail renders as "sem e-mail" in card and text mirrors', () => {
    const noMail = { id: '9', displayName: 'Ana', mail: null };
    expect(JSON.stringify(buildReminderConfirmCard(noMail, 'QZ-1', 'S', undefined, 'n'))).toContain('sem e-mail');
    expect(renderReminderConfirm(noMail, 'QZ-1', 'S', undefined)).toContain('sem e-mail');
    expect(renderReminderPick([noMail], 'QZ-1')).toContain('sem e-mail');
  });
  it('text mirror carries the note only when there is one', () => {
    expect(renderReminderConfirm(user, 'QZ-1', 'S', 'reunião')).toContain('Nota: reunião');
    expect(renderReminderConfirm(user, 'QZ-1', 'S', undefined)).not.toContain('Nota:');
  });
  it('pick card caps candidates and names the overflow count (Review Focus 4)', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i), displayName: `João ${i}`, mail: null }));
    const card = buildReminderPickCard(many, 'QZ-1', 'n') as unknown as CardActions;
    expect(card.actions.filter((a) => a.verb === REMIND_PICK_ACTION)).toHaveLength(REMINDER_CANDIDATE_CAP);
    expect(JSON.stringify(card)).toContain('e mais 2');
    expect(renderReminderPick(many, 'QZ-1')).toContain('e mais 2');
  });
  it('pick buttons carry the nonce and the candidate index only (spec §5.1)', () => {
    const two = [user, { id: '2', displayName: 'João Silva', mail: null }];
    const card = buildReminderPickCard(two, 'QZ-1', 'nonce-1') as unknown as CardActions;
    expect(card.actions.map((a) => a.data)).toEqual([
      { action: REMIND_PICK_ACTION, nonce: 'nonce-1', index: 0 },
      { action: REMIND_PICK_ACTION, nonce: 'nonce-1', index: 1 },
    ]);
  });
});

describe('parseReminderPayload (spec §5.1)', () => {
  it('accepts a nonce, with or without an integer index', () => {
    expect(parseReminderPayload({ action: 'x', nonce: 'abc' })).toEqual({ nonce: 'abc' });
    expect(parseReminderPayload({ action: 'x', nonce: 'abc', index: 1 })).toEqual({ nonce: 'abc', index: 1 });
  });
  it.each([
    ['a non-object', 'x'], ['null', null], ['no nonce', { action: 'x' }], ['a blank nonce', { nonce: '  ' }],
    ['a numeric nonce', { nonce: 5 }], ['a negative index', { nonce: 'a', index: -1 }],
    ['a fractional index', { nonce: 'a', index: 0.5 }], ['a string index', { nonce: 'a', index: '0' }],
  ])('rejects %s', (_n, data) => expect(parseReminderPayload(data)).toBeNull());
  it('ignores stale client fields: a recipient id in the payload is never read', () => {
    expect(parseReminderPayload({ nonce: 'a', userId: 'evil', note: 'x' })).toEqual({ nonce: 'a' });
  });
});

describe('buildReminderDm', () => {
  const args = { requester: 'Andres', cardKey: 'QZ-1', summary: 'Erro no relatório', status: 'Em Teste',
    url: 'https://site/browse/QZ-1', note: 'reunião às 10h' };
  it('contains requester, linked card, status, quoted note and the reply-to-requester line', () => {
    const dm = buildReminderDm(args);
    for (const s of ['**Andres**', '[QZ-1](https://site/browse/QZ-1)', 'Erro no relatório', 'Em Teste',
      '> reunião às 10h', 'responda diretamente a Andres']) expect(dm).toContain(s);
  });
  it('omits the note block when absent', () =>
    expect(buildReminderDm({ ...args, note: undefined })).not.toContain('>'));
  it('omits the status line when there is no status', () =>
    expect(buildReminderDm({ ...args, status: undefined })).not.toContain('Status atual'));
  it('a markdown-laden note stays inside the quote block', () => {
    const dm = buildReminderDm({ ...args, note: 'urgente ** veja ] isto' });
    expect(dm).toContain('> urgente ** veja \\] isto');
  });
  // Review M5: a note must not be able to render a live link in the DM.
  it('neutralizes markdown link syntax in the note', () => {
    const dm = buildReminderDm({ ...args, note: 'veja [clique](https://evil.example)' });
    expect(dm).toContain('> veja \\[clique\\](https://evil.example)');
    expect(dm).not.toContain('[clique]');
  });
  it('a multi-line note is flattened so it cannot escape the quote block', () =>
    expect(buildReminderDm({ ...args, note: 'a\nb' })).toContain('> a b'));
  it('never contains internal-note markers (multiparty safety, spec §6)', () =>
    expect(buildReminderDm(args)).not.toMatch(/nota interna|interno/i));
});

describe('assigneeMatches', () => {
  it('tolerates middle names either way', () => {
    expect(assigneeMatches('João Silva', 'João Carlos Silva')).toBe(true);
    expect(assigneeMatches('João Carlos Silva', 'João Silva')).toBe(true);
  });
  it('rejects a different person', () => expect(assigneeMatches('Maria Souza', 'João Silva')).toBe(false));
});

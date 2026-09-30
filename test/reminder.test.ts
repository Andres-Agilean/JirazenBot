import { describe, expect, it } from 'vitest';
import { bundleAssignee, parseLembrar, NOTE_MAX_CHARS } from '@/teams/reminder.js';
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

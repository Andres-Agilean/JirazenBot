import { describe, expect, it } from 'vitest';
import { detectJiraMirror } from '@/fetch/jiraMirror.js';

describe('detectJiraMirror', () => {
  it('detects the real live prefix (em dash separator)', () => {
    expect(detectJiraMirror('[Jira] QZ-252 — André Marques:\n\n{panel}...')).toEqual({
      issueKey: 'QZ-252',
      author: 'André Marques',
    });
  });

  it('detects the "This Ticket has been escalated" style automation author', () => {
    expect(detectJiraMirror('[Jira] QZ-252 — Automation for Jira:\n\nIncidente foi bloqueado')).toEqual({
      issueKey: 'QZ-252',
      author: 'Automation for Jira',
    });
  });

  it('tolerates a plain hyphen or en dash separator', () => {
    expect(detectJiraMirror('[Jira] AGL-1658 - Someone:\n\nbody')).toEqual({ issueKey: 'AGL-1658', author: 'Someone' });
    expect(detectJiraMirror('[Jira] AGL-1658 – Someone:\n\nbody')).toEqual({ issueKey: 'AGL-1658', author: 'Someone' });
  });

  it('returns null for an ordinary, non-mirrored comment', () => {
    expect(detectJiraMirror('Ao tirar uma foto o aplicativo fecha')).toBeNull();
  });

  it('returns null when the prefix text appears but not anchored at the start', () => {
    expect(detectJiraMirror('Nota: [Jira] QZ-252 — X:\n\nbody')).toBeNull();
  });

  it('returns null for the escalation-notice comment, which is not itself a mirror', () => {
    expect(detectJiraMirror('This Ticket has been escalated to Jira QZ-252')).toBeNull();
  });
});

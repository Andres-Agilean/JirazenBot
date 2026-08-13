import { describe, expect, it } from 'vitest';
import { parseReference } from '@/resolve/parseReference.js';

const projects = ['AGL', 'AI', 'MDO', 'QZ', 'SC'];
const p = (text: string) => parseReference(text, projects);

describe('parseReference', () => {
  it('parses a bare Jira issue key in allowed projects', () => {
    expect(p('dá uma olhada no QZ-252 por favor')).toEqual({ system: 'jira', issueKey: 'QZ-252', explicit: true });
  });

  it('rejects issue keys from projects outside the allowlist', () => {
    expect(p('vi isso no XYZ-99')).toBeNull();
  });

  it('finds an allowed key even after a disallowed dash token', () => {
    expect(p('converti pra UTF-8 mas o bug real e o AGL-100')).toEqual({ system: 'jira', issueKey: 'AGL-100', explicit: true });
    expect(p('vi isso no XYZ-99 mas o certo e o AGL-100')).toEqual({ system: 'jira', issueKey: 'AGL-100', explicit: true });
  });

  it('parses Jira browse URLs', () => {
    expect(p('https://your-tenant.atlassian.net/browse/AGL-1658')).toEqual({ system: 'jira', issueKey: 'AGL-1658', explicit: true });
  });

  it('parses Jira board/issues URLs', () => {
    expect(p('https://your-tenant.atlassian.net/jira/software/c/projects/QZ/issues/QZ-252')).toEqual({ system: 'jira', issueKey: 'QZ-252', explicit: true });
  });

  it('rejects Jira URLs pointing at disallowed projects', () => {
    expect(p('https://your-tenant.atlassian.net/browse/XYZ-99')).toBeNull();
  });

  it('parses Zendesk agent ticket URLs', () => {
    expect(p('https://your-subdomain.zendesk.com/agent/tickets/16467')).toEqual({ system: 'zendesk', ticketId: '16467', explicit: true });
  });

  it('parses #-marked ticket ids', () => {
    expect(p('sobre o #16467, qual o status?')).toEqual({ system: 'zendesk', ticketId: '16467', explicit: true });
  });

  it.each(['chamado 11234', 'Chamado 11234', 'ticket 11234', 'ZD 11234', 'zd11234'])('parses keyword form %s', (text) => {
    expect(p(text)).toEqual({ system: 'zendesk', ticketId: '11234', explicit: true });
  });

  // The tenant's staff use "ticket" and "chamado" interchangeably, and pluralise both. The
  // original pattern accepted only the singular with whitespace or "#" before the number, so
  // "tickets 11234" and "chamado: 11234" parsed as nothing at all and the bot asked what card
  // the user meant.
  it.each([
    'tickets 11234',
    'Tickets 11234',
    'chamados 11234',
    'os tickets 11234',
    'ticket: 11234',
    'chamado: 11234',
    'ticket - 11234',
    'ticket nº 11234',
    'ticket n 11234',
    'ticket no 11234',
    'ticket numero 11234',
    'ticket número 11234',
    'tickets #11234',
  ])('parses the plural and separator forms: %s', (text) => {
    expect(p(text)).toEqual({ system: 'zendesk', ticketId: '11234', explicit: true });
  });

  it('does not let the widened keyword form swallow unrelated counts', () => {
    expect(p('abrimos 3 tickets essa semana')).toBeNull();
    expect(p('fechamos os chamados ontem')).toBeNull();
    expect(p('nao consigo abrir o ticket')).toBeNull();
  });

  it('treats a whole-message bare number as a non-explicit Zendesk ref', () => {
    expect(p('16467')).toEqual({ system: 'zendesk', ticketId: '16467', explicit: false });
    expect(p('  16467? ')).toEqual({ system: 'zendesk', ticketId: '16467', explicit: false });
  });

  it('ignores numbers inside sentences', () => {
    expect(p('vimos 3 casos desses no trimestre, faz 12 dias')).toBeNull();
  });

  it('prefers a URL over other forms in the same message', () => {
    expect(p('chamado 999 https://your-tenant.atlassian.net/browse/AGL-1658')).toEqual({ system: 'jira', issueKey: 'AGL-1658', explicit: true });
  });

  it('returns null for plain conversation', () => {
    expect(p('bom dia, tudo bem?')).toBeNull();
  });
});

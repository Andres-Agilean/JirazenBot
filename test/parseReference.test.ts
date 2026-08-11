import { describe, expect, it } from 'vitest';
import { parseReference } from '../src/resolve/parseReference.js';

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

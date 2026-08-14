import { describe, expect, it } from 'vitest';
import { buildAnswerCard, cardStatus, PERSONAL_MARKER, REFRESH_ACTION, styleCitations } from '@/teams/cards.js';
import { parseCommand } from '@/teams/commands.js';
import { testConfig } from './helpers.js';
import type { Binding } from '@/teams/bindings.js';
import type { CardBundle } from '@/bundle/types.js';

function makeBinding(opts: { jira?: boolean; zendesk?: boolean; status?: string } = {}): Binding {
  const { jira = true, zendesk = true, status = 'Em Teste' } = opts;
  const bundle = {
    fetchedAt: '2026-08-13T17:32:00.000Z',
    surface: 'dm',
    // `fields` is keyed by Jira field ID, and `status` is an OBJECT, not a string. Writing
    // `{ Status: 'Em Teste' }` here would make the test pass against a card that reads nothing.
    ...(jira
      ? { jira: { issueId: '1', issueKey: 'QZ-252', fields: { status: { name: status } }, comments: [], statusHistory: [] } }
      : {}),
    ...(zendesk
      ? { zendesk: { ticketId: '16467', subject: 's', status: 'open', priority: null, createdAt: '', updatedAt: '', comments: [], internalNotesOmitted: false } }
      : {}),
    resolution: { via: 'jira_zendesk_id_field', ambiguous: false },
    truncationNotes: [],
  } as unknown as CardBundle;
  return { ref: { system: 'jira', issueKey: 'QZ-252', explicit: true }, bundle, bundleFetchedAt: 0, history: [], boundAt: 0 };
}

/** Depth-first collection of every element of a given type, so tests do not hardcode indices. */
function collect(node: unknown, type: string, out: Record<string, unknown>[] = []) {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, type, out)); return out; }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === type) out.push(o);
    Object.values(o).forEach((v) => collect(v, type, out));
  }
  return out;
}

describe('cardStatus', () => {
  it('prefers the Jira status', () => {
    expect(cardStatus(makeBinding().bundle)).toBe('Em Teste');
  });
  it('falls back to the Zendesk status when there is no Jira side', () => {
    expect(cardStatus(makeBinding({ jira: false }).bundle)).toBe('open');
  });
  it('is null when neither side carries one', () => {
    expect(cardStatus(makeBinding({ jira: false, zendesk: false }).bundle)).toBeNull();
  });
});

describe('styleCitations', () => {
  it('italicises a bracketed source citation', () => {
    expect(styleCitations('Aprovado em 11/08 [comentário jira 41713, André Marques].')).toBe(
      'Aprovado em 11/08 _[comentário jira 41713, André Marques]_.',
    );
  });

  it('italicises every citation in a sentence', () => {
    expect(styleCitations('Ver [descrição Jira] e [campo Status].')).toBe(
      'Ver _[descrição Jira]_ e _[campo Status]_.',
    );
  });

  // A markdown link is not a citation; italicising its label would break the link.
  it('leaves markdown links alone', () => {
    expect(styleCitations('veja [QZ-252](https://example.com/browse/QZ-252)')).toBe(
      'veja [QZ-252](https://example.com/browse/QZ-252)',
    );
  });

  it('leaves prose without citations unchanged', () => {
    expect(styleCitations('O chamado segue em aberto.')).toBe('O chamado segue em aberto.');
  });
});

describe('buildAnswerCard', () => {
  it('italicises citations in the answer block', () => {
    const card = buildAnswerCard('Aprovado [comentário jira 41713].', makeBinding(), testConfig);
    const body = collect(card, 'TextBlock')
      .map((b) => String(b.text))
      .find((t) => t.includes('Aprovado'));
    expect(body).toBe('Aprovado _[comentário jira 41713]_.');
  });

  // The header used to build its own unlinked copy of the identity, so the key and ticket number
  // rendered as dead text in the card while the identical footer text was clickable.
  it('hyperlinks the Jira key and the Zendesk ticket in the header', () => {
    const card = buildAnswerCard('r', makeBinding(), testConfig);
    const header = collect(card, 'TextBlock')
      .map((b) => String(b.text))
      .find((t) => t.includes('QZ-252'));
    expect(header).toContain('[QZ-252](https://your-tenant.atlassian.net/browse/QZ-252)');
    expect(header).toContain('[chamado 16467](https://your-subdomain.zendesk.com/agent/tickets/16467)');
  });

  it('links only the side a single-sided card has', () => {
    const jiraOnly = collect(buildAnswerCard('r', makeBinding({ zendesk: false }), testConfig), 'TextBlock')
      .map((b) => String(b.text)).find((t) => t.includes('QZ-252'));
    expect(jiraOnly).toContain('/browse/QZ-252');
    expect(jiraOnly).not.toContain('zendesk.com');
    expect(jiraOnly).not.toContain('↔');
  });

  it('is a valid Adaptive Card envelope', () => {
    const card = buildAnswerCard('resposta', makeBinding(), testConfig);
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.5');
    expect(card.$schema).toBe('http://adaptivecards.io/schemas/adaptive-card.json');
  });

  it('puts the card identity and status above the answer', () => {
    const card = buildAnswerCard('resposta do modelo', makeBinding(), testConfig);
    const texts = collect(card, 'TextBlock').map((b) => String(b.text));
    const header = texts.findIndex((t) => t.includes('QZ-252'));
    const status = texts.findIndex((t) => t.includes('Em Teste'));
    const body = texts.findIndex((t) => t.includes('resposta do modelo'));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(header);
    expect(body).toBeGreaterThan(status);
  });

  it('shows the collection time in Brazil local time', () => {
    const card = buildAnswerCard('r', makeBinding(), testConfig);
    const texts = collect(card, 'TextBlock').map((b) => String(b.text)).join(' ');
    expect(texts).toContain('14:32'); // 17:32Z
  });

  it('wraps the answer so long prose is not clipped', () => {
    const card = buildAnswerCard('r'.repeat(500), makeBinding(), testConfig);
    const body = collect(card, 'TextBlock').find((b) => String(b.text).startsWith('rrr'));
    expect(body?.wrap).toBe(true);
  });

  it('offers Atualizar, Jira and Zendesk actions with the right urls', () => {
    const card = buildAnswerCard('r', makeBinding(), testConfig);
    const actions = collect(card, 'Action.OpenUrl');
    const urls = actions.map((a) => String(a.url));
    expect(urls).toContain('https://your-tenant.atlassian.net/browse/QZ-252');
    expect(urls).toContain('https://your-subdomain.zendesk.com/agent/tickets/16467');
    expect(collect(card, 'Action.Execute')).toHaveLength(1);
  });

  it('omits the Zendesk action for a Jira-only card', () => {
    const card = buildAnswerCard('r', makeBinding({ zendesk: false }), testConfig);
    const urls = collect(card, 'Action.OpenUrl').map((a) => String(a.url));
    expect(urls.some((u) => u.includes('zendesk'))).toBe(false);
    expect(urls.some((u) => u.includes('atlassian'))).toBe(true);
  });

  it('omits the Jira action for a Zendesk-only card', () => {
    const card = buildAnswerCard('r', makeBinding({ jira: false }), testConfig);
    const urls = collect(card, 'Action.OpenUrl').map((a) => String(a.url));
    expect(urls.some((u) => u.includes('atlassian'))).toBe(false);
    expect(urls.some((u) => u.includes('zendesk'))).toBe(true);
  });

  it('marks a personal answer so the reader knows it is off the threads card', () => {
    const shared = buildAnswerCard('r', makeBinding(), testConfig);
    const split = buildAnswerCard('r', makeBinding(), testConfig, { personal: true });
    expect(JSON.stringify(shared)).not.toContain(PERSONAL_MARKER);
    expect(JSON.stringify(split)).toContain(PERSONAL_MARKER);
  });

  it('REFRESH_ACTION is the exact verb parseCommand recognizes as atualizar, so the button can never drift from the command', () => {
    expect(parseCommand(REFRESH_ACTION)).toBe('atualizar');
  });
});

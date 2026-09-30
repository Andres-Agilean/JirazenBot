import { describe, expect, it } from 'vitest';
import type { CardBundle } from '@/bundle/types.js';
import { compressCitations } from '@/teams/citations.js';

describe('compressCitations', () => {
  it('shortens a jira comment citation', () => {
    expect(compressCitations('[comentário jira 10234]')).toBe('[jira 10234]');
  });

  it('elides a long zendesk comment id to its last 4 digits', () => {
    expect(compressCitations('[comentário zendesk 40123456789]')).toBe('[zendesk …6789]');
  });

  it('keeps a short zendesk comment id whole (6 digits or fewer)', () => {
    expect(compressCitations('[comentário zendesk 90001]')).toBe('[zendesk 90001]');
    expect(compressCitations('[comentário zendesk 123456]')).toBe('[zendesk 123456]');
    expect(compressCitations('[comentário zendesk 1234567]')).toBe('[zendesk …4567]');
  });

  it('drops the "campo" prefix', () => {
    expect(compressCitations('[campo Status]')).toBe('[Status]');
    expect(compressCitations('[campo customfield_10042]')).toBe('[customfield_10042]');
  });

  it('handles a mixed sentence', () => {
    expect(
      compressCitations('Falhou [comentário jira 11] e o cliente confirmou [comentário zendesk 40123456789] [campo Status].'),
    ).toBe('Falhou [jira 11] e o cliente confirmou [zendesk …6789] [Status].');
  });

  describe('with a bundle', () => {
    const bundle = {
      fetchedAt: '2026-08-14T17:32:00.000Z',
      surface: 'dm',
      jira: {
        issueId: '1', issueKey: 'QZ-1', fields: {}, statusHistory: [],
        comments: [{ id: '41713', author: 'a', createdAt: '2026-08-11T17:34:00Z', body: 'x' }],
      },
      zendesk: {
        ticketId: '9', subject: 's', status: 'open', priority: null, createdAt: '', updatedAt: '',
        internalNotesOmitted: false,
        comments: [{ id: 40123456789, author: 'b', isPublic: false, createdAt: '2026-08-14T14:52:00Z', body: 'y' }],
      },
      resolution: { via: 'direct_only', ambiguous: false },
      truncationNotes: [],
    } as CardBundle;

    it('renders a known jira comment as its timestamp', () => {
      expect(compressCitations('[comentário jira 41713]', bundle)).toBe('[jira 11/08 14:34]');
    });

    it('renders a known zendesk comment (numeric id) as its timestamp', () => {
      expect(compressCitations('[comentário zendesk 40123456789]', bundle)).toBe('[zendesk 14/08 11:52]');
    });

    it('falls back to the id forms for ids not in the bundle', () => {
      expect(compressCitations('[comentário jira 99999] [comentário zendesk 40999999999]', bundle)).toBe(
        '[jira 99999] [zendesk …9999]',
      );
    });

    it('is idempotent with timestamps', () => {
      const once = compressCitations('[comentário jira 41713] [comentário zendesk 40123456789] [campo Status]', bundle);
      expect(once).toBe('[jira 11/08 14:34] [zendesk 14/08 11:52] [Status]');
      expect(compressCitations(once, bundle)).toBe(once);
    });
  });

  it('is idempotent', () => {
    const raw = '[comentário jira 11] [comentário zendesk 40123456789] [campo Status]';
    const once = compressCitations(raw);
    expect(compressCitations(once)).toBe(once);
  });

  it('leaves text without citations untouched', () => {
    const text = '**Sem citação** - item [1] e [outro] (campo) comentário jira 5';
    expect(compressCitations(text)).toBe(text);
  });
});

import { describe, expect, it } from 'vitest';
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

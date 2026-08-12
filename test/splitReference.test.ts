import { describe, expect, it } from 'vitest';
import { splitReferenceAndQuestion } from '../scripts/splitReference.js';
import { testConfig } from './helpers.js';

const allowed = testConfig.allowedProjects;

describe('splitReferenceAndQuestion', () => {
  it('splits a one-word Jira key reference from the question', () => {
    expect(splitReferenceAndQuestion('QZ-252 qual o status?', allowed)).toEqual({
      ref: { system: 'jira', issueKey: 'QZ-252', explicit: true },
      question: 'qual o status?',
    });
  });

  it('splits a two-word "chamado N" reference from the question', () => {
    expect(splitReferenceAndQuestion('chamado 16467 quem validou?', allowed)).toEqual({
      ref: { system: 'zendesk', ticketId: '16467', explicit: true },
      question: 'quem validou?',
    });
  });

  it('keeps a number inside the question distinct from the reference number', () => {
    // Regression: an unanchored match on a longer prefix must not swallow "26" into the
    // reference or otherwise mis-split once the question itself contains digits.
    expect(
      splitReferenceAndQuestion('chamado 16467 quantos dos 26 casos passaram?', allowed),
    ).toEqual({
      ref: { system: 'zendesk', ticketId: '16467', explicit: true },
      question: 'quantos dos 26 casos passaram?',
    });
  });

  it('splits a "#N" reference from the question', () => {
    expect(splitReferenceAndQuestion('#16467 e agora?', allowed)).toEqual({
      ref: { system: 'zendesk', ticketId: '16467', explicit: true },
      question: 'e agora?',
    });
  });

  it('splits a pasted Jira URL reference from the question', () => {
    expect(
      splitReferenceAndQuestion(
        'https://your-tenant.atlassian.net/browse/QZ-252 qual o status?',
        allowed,
      ),
    ).toEqual({
      ref: { system: 'jira', issueKey: 'QZ-252', explicit: true },
      question: 'qual o status?',
    });
  });

  it('splits a pasted Zendesk URL reference from the question', () => {
    expect(
      splitReferenceAndQuestion('https://your-subdomain.zendesk.com/agent/tickets/16467 e agora?', allowed),
    ).toEqual({
      ref: { system: 'zendesk', ticketId: '16467', explicit: true },
      question: 'e agora?',
    });
  });

  it('returns null when there is a reference but no question', () => {
    expect(splitReferenceAndQuestion('QZ-252', allowed)).toBeNull();
  });

  it('returns null when no reference parses at all', () => {
    expect(splitReferenceAndQuestion('bom dia tudo bem?', allowed)).toBeNull();
  });
});

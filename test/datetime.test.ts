import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatDayMonthTime } from '@/text/datetime.js';

describe('formatDateTime', () => {
  it('converts a UTC instant to Brazil local time', () => {
    // 03:17Z is 00:17 in America/Sao_Paulo (UTC-3) -- the case that prompted this: a card
    // updated just after local midnight was displaying as 03:17 the same day.
    expect(formatDateTime('2026-08-14T03:17:27.802Z')).toBe('14/08/2026 00:17');
  });

  it('rolls the date back when the UTC instant is the next day locally', () => {
    expect(formatDateTime('2026-08-14T02:00:00.000Z')).toBe('13/08/2026 23:00');
  });

  it('handles an offset-bearing timestamp', () => {
    expect(formatDateTime('2026-08-13T23:00:00-03:00')).toBe('13/08/2026 23:00');
  });

  it('does NOT shift a date-only value', () => {
    // Jira's duedate is a calendar date. Passing it through a timezone would move it to the
    // previous day, turning a deadline of the 14th into the 13th.
    expect(formatDateTime('2026-08-14')).toBe('14/08/2026');
  });

  it('returns unparseable input unchanged rather than "Invalid Date"', () => {
    expect(formatDateTime('não informado')).toBe('não informado');
    expect(formatDateTime('')).toBe('');
  });
});

describe('formatDate', () => {
  it('drops the time', () => {
    expect(formatDate('2026-08-14T03:17:27.802Z')).toBe('14/08/2026');
  });

  it('does not shift a date-only value', () => {
    expect(formatDate('2026-08-14')).toBe('14/08/2026');
  });

  it('returns unparseable input unchanged', () => {
    expect(formatDate('sem data')).toBe('sem data');
  });
});

describe('formatDayMonthTime', () => {
  it('renders DD/MM HH:mm in Brazil local time', () => {
    expect(formatDayMonthTime('2026-08-11T17:34:00Z')).toBe('11/08 14:34');
  });

  it('crosses midnight backwards for a UTC instant early in the next day', () => {
    expect(formatDayMonthTime('2026-08-12T01:30:00Z')).toBe('11/08 22:30');
  });

  it('returns unparseable input unchanged', () => {
    expect(formatDayMonthTime('nao-e-data')).toBe('nao-e-data');
    expect(formatDayMonthTime('')).toBe('');
  });
});

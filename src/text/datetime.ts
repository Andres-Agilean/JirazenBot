/**
 * Every human-facing date in this project is rendered in Brazil local time. The tenant's staff
 * are in Brazil; Jira and Zendesk both return UTC. Left raw, a ticket updated at 00:17 local
 * reads as `2026-08-14T03:17:27.802Z` — three hours off and in a format nobody reads aloud.
 *
 * These helpers live outside `src/teams/` because both the bundle renderer (what Claude reads,
 * and therefore what it quotes back) and the Teams reply layer need the same timezone.
 */
export const DISPLAY_TIMEZONE = 'America/Sao_Paulo';

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: DISPLAY_TIMEZONE,
});

const DATE_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: DISPLAY_TIMEZONE,
});

const DAY_MONTH_TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: DISPLAY_TIMEZONE,
});

/** True for a date-only value like Jira's `duedate` ("2026-08-14"), which has no time to shift. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Formats an ISO 8601 instant as `14/08/2026 00:17` in Brazil local time. A date-only value is
 * formatted as `14/08/2026` and deliberately NOT shifted: Jira's `duedate` is a calendar date,
 * so converting it through a timezone would move it to the previous day.
 *
 * Returns the input unchanged when it is not a date this can parse, so an unexpected field value
 * degrades to the raw string rather than to `Invalid Date`.
 */
export function formatDateTime(value: string): string {
  if (value === '') return value;
  if (isDateOnly(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // pt-BR's Intl output separates date and time with a comma ("14/08/2026, 00:17"). Dropping it
  // reads better inline in a bundle field or a card subtitle. The locale is pinned above, so
  // this is not guessing at some other locale's separator.
  return DATE_TIME_FORMAT.format(parsed).replace(', ', ' ');
}

/**
 * Compact `DD/MM HH:mm` in Brazil local time (e.g. `11/08 14:34`), for citation labels where the
 * year is noise. Returns the input unchanged when it cannot be parsed.
 */
export function formatDayMonthTime(value: string): string {
  const parsed = new Date(value);
  if (value === '' || Number.isNaN(parsed.getTime())) return value;
  return DAY_MONTH_TIME_FORMAT.format(parsed).replace(', ', ' ');
}

/** Date without the time, in Brazil local time. Used where a time would be noise. */
export function formatDate(value: string): string {
  if (value === '') return value;
  if (isDateOnly(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return DATE_FORMAT.format(parsed);
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export function scrubEmails(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(EMAIL, 'user@example.com');
  if (Array.isArray(value)) return value.map(scrubEmails);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubEmails(v)]));
  }
  return value;
}

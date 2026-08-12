// Shared across both API clients so neither has to import an error type from the other.

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Não encontrado: ${what}`);
    this.name = 'NotFoundError';
  }
}

/** Both clients' `get()` throw this identically-shaped message for any non-404 error status. */
export function httpStatusError(service: 'Jira' | 'Zendesk', status: number, path: string): Error {
  return new Error(`${service} ${status} em ${path}`);
}

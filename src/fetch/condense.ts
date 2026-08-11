import type { RawChangelogEntry } from './jira.js';

export interface Transition {
  field: 'status' | 'assignee';
  from: string | null;
  to: string | null;
  at: string;
  by: string;
}

export function condenseChangelog(entries: RawChangelogEntry[]): Transition[] {
  const out: Transition[] = [];
  for (const e of entries) {
    for (const item of e.items) {
      if (item.field === 'status' || item.field === 'assignee') {
        out.push({ field: item.field, from: item.fromString, to: item.toString, at: e.at, by: e.by });
      }
    }
  }
  return out;
}

export function condenseDevelopment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/json=(\{.*\})\}$/s);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as {
      cachedValue?: { summary?: { pullrequest?: { overall?: { count?: number; state?: string; lastUpdated?: string } } } };
    };
    const overall = parsed.cachedValue?.summary?.pullrequest?.overall;
    if (!overall?.count) return null;
    const plural = overall.count === 1 ? 'pull request' : 'pull requests';
    const date = overall.lastUpdated ? ` (atualizado ${overall.lastUpdated.slice(0, 10)})` : '';
    return `${overall.count} ${plural} — ${overall.state ?? '?'}${date}`;
  } catch {
    return null;
  }
}

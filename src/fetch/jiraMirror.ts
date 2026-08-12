// This tenant's Jira<->Zendesk integration mirrors every Jira comment into Zendesk as an
// internal note with a literal "[Jira] <ISSUE-KEY> <dash> <author>:" prefix -- verified live on
// ticket 16467 / QZ-252 (comment id 54276177045147, `public: false`). The mirrored body is raw
// Jira wiki markup pasted as plain text (Zendesk's ADF converter, fetch/adf.ts, never sees it,
// because it never arrives as an ADF document on the Zendesk side) and is a verbatim duplicate
// of a comment the bundle already renders once from the Jira side. Detecting the prefix lets the
// renderer (bundle/render.ts) collapse the duplicate into a one-line pointer instead of repeating
// the whole body -- see wikiToMarkdown.ts for cleaning the body of comments that aren't dropped.
//
// Pure and side-effect free so it can be unit tested directly against real captured bodies
// without spinning up a ZendeskClient.

export interface JiraMirrorMatch {
  issueKey: string;
  author: string;
}

// Jira issue keys are PROJECT-NUMBER, project key always starting with a letter. The separator
// between key and author is an em dash in every live sample, but this is operator-typed
// integration text (not a documented, guaranteed-stable format), so an en dash or plain hyphen
// is tolerated too rather than requiring an exact byte match.
const JIRA_MIRROR_PREFIX = /^\[Jira\]\s+([A-Z][A-Z0-9]*-\d+)\s*[—–-]\s*(.+?):/;

/** Returns the referenced Jira issue key and comment author if `body` opens with the mirror prefix, else null. */
export function detectJiraMirror(body: string): JiraMirrorMatch | null {
  const m = JIRA_MIRROR_PREFIX.exec(body);
  if (!m) return null;
  return { issueKey: m[1], author: m[2] };
}

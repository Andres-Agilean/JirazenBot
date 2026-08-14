# CLAUDE.md

Working rules for this repo. Read before changing anything.

The project: a Microsoft Teams bot answering free-form questions in Brazilian Portuguese about one
work item at a time — a Jira issue and/or its linked Zendesk ticket. See `README.md` for what it
does; this file is how to work on it.

---

## Hard rules — these are not preferences

**1. STRICTLY READ-ONLY against Jira and Zendesk.** No POST, PUT, PATCH or DELETE to either
system, ever — no comments, no transitions, no field edits. Every client method is a GET. If a
task seems to need a write, stop and ask; do not implement one.

**2. All human-facing strings are Brazilian Portuguese.** Never leak a stack trace, an exception
message, or an English error to a user.

**3. The bot must never go silent.** Every path returns at least one reply. An unanswered message
reads as a broken bot, so "return early and send nothing" is a defect even when nothing went
wrong. Empty reply arrays are forbidden.

**4. The Teams SDK is imported in exactly one file:** `src/teams/app.ts`. `@microsoft/teams.*`
anywhere else breaks the seam that lets the whole message pipeline be tested with no SDK, no
network and no API key. `src/teams/cards.ts` builds Adaptive Cards as plain object literals for
this reason, even though `@microsoft/teams.cards` is installed.

**5. Fail closed on the surface flag.** Only an exact `'personal'` conversation type yields the
`dm` surface. Everything else — `groupChat`, `channel`, `undefined`, a value Microsoft adds next
year — yields `multiparty`, which omits internal Zendesk agent notes. The SDK types the field as
an open union, so unrecognised values are reachable. The costs are asymmetric: fail closed and a
DM loses notes it was entitled to (visible, annoying); fail open and agent-only notes reach a
channel (silent, not undoable).

**6. `loadCardBundle` is called once per binding, never per message.** Its `fetched_at` is baked
into the cached prompt prefix, so re-assembling per message invalidates the cache and refetches
both tenants on every turn. It fails quietly — you just stop benefiting — so this is a review
item, not something the tests catch.

**7. `npm test` stays fully offline.** No network, no API key. If a change makes a test need
either, the change is wrong.

**8. Never run anything that spends money without being asked.** `npm run eval` (~US$0.09/run),
`npm run ask`, and `npm run bot` all make live Anthropic and/or tenant calls. Offline work means
offline.

---

## Code style

Established by the project owner, who asked for a maintainability pass after every stage:

- **Named constants, no magic values.** A literal appearing in two places is a bug waiting to
  drift — derive one from the other. (`REFRESH_ACTION` derives from `ATUALIZAR_COMMAND` so the
  card's verb cannot drift from what `parseCommand` accepts.)
- **No duplicated logic.** Extract and share rather than copy. Existing shared helpers:
  `normalizeText`, `formatDateTime`/`formatDate`, `cardIdentity`, `collectedAt`, `renderGeneric`.
- **ESM throughout.** `@/` alias for imports inside `src/`, `./` for same-directory, `.js`
  extensions on every import, `import type` for type-only imports. The `@/` alias covers `src/`
  only — `scripts/` is imported relatively.
- **No build step.** `tsc --noEmit` typechecks; tsx and vitest resolve at runtime.
- **Verify before claiming.** Run the command and read the output. "Should work" is not evidence.

---

## Testing

- **TDD.** Write the failing test, watch it fail for the right reason, then implement.
- **Never weaken a test to make it pass.** Changing a call's *shape* when a signature changed is
  fine. Changing what it *asserts* is not. If an assertion genuinely blocks a fix, stop and
  report — it usually means the fix is wrong, not the test.
  - A real example worth remembering: an assertion was "adapted" from checking a string field to
    `JSON.stringify(wholeObject).toContain(...)`. That looks like a read-shape change but is a
    silent weakening — the substring now matches anywhere in the payload, so the property the test
    existed to protect could be deleted and it would still pass.
- **The Phase 3 DM tests in `test/handleMessage.test.ts` are the regression proof** that the
  two-layer binding model collapses to single-user behaviour in a DM. Treat a failure there as a
  design problem, not a test to update.
- **The grounding eval measures itself if you are careless.** `harvestBundleDates` learns which
  dates are legitimate by scanning the *rendered bundle*. Change the renderer's date format
  without updating that harvest and the allowed set empties, turning every correctly-quoted date
  into an "invented" one and failing the whole corpus. This has bitten the project twice.

---

## Tenant facts that are easy to get wrong

- **A scoped Atlassian API token only works against `https://api.atlassian.com/ex/jira/{cloudId}`**,
  never against the site URL, which returns 401/404. `Config.siteUrl` is for links humans click;
  `Config.jiraApiBaseUrl` is for the API. Mixing them produces links that 404 for everyone.
- **Zendesk cursor pagination: `links.next` is ALWAYS present.** Only `meta.has_more` is
  authoritative. Trusting `links.next` made every ticket claim its comments were truncated.
- **`bundle.jira.fields` is keyed by Jira field ID, not display label**, and values are often
  objects — `status` is `{ name: 'Em Teste', … }`, not a string. Use `renderGeneric` to extract.
  Reading `fields.Status` silently yields `undefined`, and a fixture written the same wrong way
  passes while the real bot shows nothing.
- **The tenant mirrors Jira comments into Zendesk as internal notes.** `detectJiraMirror` collapses
  them at render time; a mirrored comment is the same statement as its Jira original, not a second
  independent confirmation.
- **Zendesk's links API returns 403** (Manage links disabled), so `jira_zendesk_id_field` is the
  primary resolver.

## Claude API facts

- Model is `claude-sonnet-5`, from config, never inline.
- **Sonnet 5 rejects `temperature`, `top_p` and `top_k` with a 400.** Never send sampling params.
- Thinking is `{ type: 'adaptive' }` with `output_config.effort: 'low'` — measured as both cheaper
  and more accurate than the alternatives on this corpus.
- **Prompt cache: `{ type: 'ephemeral', ttl: '1h' }` on exactly two breakpoints** (system block,
  bundle block). One hour, not the 5-minute default, because the bundle lives 15 minutes and a
  follow-up at minute 8 would otherwise pay a full-price rewrite. Phase 4b's one-shot unfurl
  should reconsider this rather than inherit it.
- **Citation styling happens at display time, never in the prompt.** The eval's `mustCite` rules
  match the exact bracketed form the model emits; restyling in `SYSTEM_PROMPT` would break
  grounding checks for a cosmetic gain.

## Timing and formatting

- Binding lifetime **24h**; bundle lifetime **15 minutes**, refetched transparently on expiry.
  These are deliberately separate: forgetting which card you meant is infuriating, answering
  "qual o status atual?" from stale data is a correctness bug.
- **All dates render in `America/Sao_Paulo`** (`src/text/datetime.ts`). Jira and Zendesk return
  UTC; users are in Brazil. Date-only values like `duedate` are deliberately **not** shifted —
  running a calendar date through a timezone moves a deadline to the previous day.

---

## Process

Work proceeds **phase by phase**, each with its own cycle:

`brainstorming → spec → writing-plans → subagent-driven-development → final review → merge`

- **Specs are tracked** in `docs/superpowers/specs/` — they record decisions and their reasoning.
- **Plans, reports and `.superpowers/` are gitignored** — working artifacts, not the record.
- Later specs amend earlier ones. Where a spec and the original build plan conflict, the spec wins.
- Merge to `main` locally when a phase is done.

**When something in a plan turns out to be wrong, say so.** Plans in this repo have contained real
defects — one put a `delete` before the operation that could fail, silently destroying user state
on an error path. Correcting a plan defect that serves the plan's stated intent is right; silently
implementing something you can see is broken is not.

## Environment

Windows. PowerShell and bash are both available and take their own syntax.

**Never use absolute `C:\...` paths in bash redirects** — the shell eats the backslashes and
creates a file with a mangled name. Use relative paths or forward slashes. This has produced a
junk file named `CUsersAfmcWorkAgileanTeamsBot.env` before.

Use a heredoc (`git commit -F -`) for multi-line commit messages; quotes inside `-m` break.

## Still open

- Link unfurling (Phase 4b) is **blocked, not deferred by choice**: it is a manifest-driven message
  extension, and the M365 Agents Playground cannot process manifests. It needs an Azure Bot
  registration and a tenant permitting sideloading.
- Phase 5: rate-limit backoff, Key Vault, structured logging with token accounting, the
  disambiguation card, the four bounded tools.
- Owner decisions, not engineering ones: customer ticket contents currently go to Anthropic on a
  personal account, and the bot runs on a personal Jira token rather than a scoped read-only
  service account.

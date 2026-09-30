# Reminder DM — nudge a card's responsible person on Teams

**Date:** 2026-09-30
**Status:** approved design
**Depends on:** the portfolio-followups phase (merged 2026-09-30) for card/verb conventions;
the Azure deployment work (Phase 5a artifacts, Entra app "Jirazen") for delivery.

## 1. Goal and owner constraints

A user talking to the bot about a card tells it to remind the card's responsible person, without
leaving Teams. Owner constraints (2026-09-30): **true proactive DM** (option a — built ready even
though delivery is untestable until the Azure Bot exists); the bot may only message **users in
the organization where it works**; matching is **primarily by name**; the bot **asks for
clarification whenever there is doubt** about who the correct person is; an explicit
**confirmation step** precedes every send.

This is the bot's first outward action toward a human. Everything in it is Teams-side:
**Jira and Zendesk stay strictly read-only** (hard rule 1 untouched).

## 2. Measured reality that shaped the design (probes, 2026-09-30)

- Jira search results carry the assignee's `accountId` and `displayName` but **no
  `emailAddress`** on this tenant.
- `GET /rest/api/3/user?accountId=…` returns **401** with the current scoped token (no
  user-read scope).

So an email-exact resolver is impossible today. **Name matching against the org directory is the
primary resolver**, made safe by the clarification step. If the Atlassian token ever gains the
user-read scope, an email-exact resolver can be added in front (strategy-shaped like the
Jira↔Zendesk resolver); that is a documented upgrade path, not v1.

## 3. Trigger

- Command, bound-card only: `lembrar responsável` (also accepted: `lembrar responsavel`,
  `lembrar o responsável`), optionally with a note after a colon —
  `lembrar responsável: reunião amanhã às 10h`. Parsed `parseCommand`-style (whole-message,
  offline-tested); constants derive verb/action names the `REFRESH_ACTION` way.
- The bound card defines the target: its Jira assignee. No bound card → pt-BR hint telling the
  user to open a card first. Card without an assignee → "este card não tem responsável", no
  directory call.
- The optional note is free text, capped (NOTE_MAX_CHARS, 280) — over the cap → pt-BR ask to
  shorten, nothing sent.

## 4. Resolution — org-scoped, name-first, doubt asks

- The assignee `displayName` is searched in the tenant directory via **Microsoft Graph**
  (`/users` filtered/searched by display name, tenant of the Jirazen Entra app). Tenant scoping
  is structural: Graph app credentials can only see the organization's own directory, so the
  org-only constraint cannot be violated by construction.
- **Members only (owner question, 2026-09-30):** Graph's `/users` covers the whole Entra
  directory — more than Teams users. The search filters to `userType eq 'Member'` and
  `accountEnabled eq true`, so guests (invited externals) and disabled/service accounts never
  appear as candidates. A member without a Teams license surfaces at delivery time instead: the
  send fails and the receipt says so (§7's honesty rule) — no license lookup in v1.
- Outcomes:
  - **Exactly one match** → confirmation card (§5).
  - **Multiple matches** → clarification card: one button per candidate (display name + email,
    which is how humans tell homonyms apart), CANDIDATE_CAP (6) with a named-overflow line in
    the §10.5 style. Picking a candidate leads to the same confirmation card.
  - **Zero matches** → "não encontrei <nome> na organização." Nothing sent, no guessing.
  - Graph error → pt-BR unavailable reply. Never silent (hard rule 3).
- Matching is normalized (accents/case via `normalizeText`) on full display name; a contains
  match is allowed for the search request, but the CONFIRMATION always shows the resolved
  person's name + email, so the human is the final check either way.

## 5. Confirmation — nothing sends without a click

A confirm card: "Enviar lembrete para **<nome>** (<email>) sobre **<KEY — summary>**?", the
note when present, and two `Action.Execute` buttons — **Enviar lembrete** / **Cancelar**.
- The payload carries the resolved Graph user id, the card key and the note (validated like the
  existing select/confirm actions; malformed → the SELECTION_INVALID-style reply).
- Cancelar → "ok, nada foi enviado."
- The confirmation expires with the binding (24h store) — a stale click → pt-BR "este lembrete
  expirou, peça novamente".
- One command → at most one DM. No repeat-send affordance on the receipt.

### 5.1 The pending-reminder record (final-review amendment, 2026-09-30)

A stateless confirmation card cannot enforce §5's "one command → at most one DM" (re-clicks,
Enviar after Cancelar, several group-chat members clicking, invoke-timeout retries all
double-send), and it forces the recipient id to be trusted from the client payload. Therefore:

- Issuing a confirmation (directly or via the pick card) stores a **pending reminder** record
  server-side, keyed by the slot like bindings: a fresh nonce (`crypto.randomUUID()`), the
  resolved recipient(s) (`DirectoryUser`), the card key, and the note. Lifetime: the binding's
  24h store semantics; a new `lembrar responsável` replaces the slot's record.
- Card buttons carry ONLY `{ action, nonce }` (the pick buttons also carry the candidate index).
  The recipient id, name, mail and note used at send time come from the SERVER record — the
  client payload can no longer name a recipient or smuggle an uncapped note.
- A pick click looks up the record by nonce and sets the chosen candidate (not one-shot — picking
  again re-renders the confirmation). **Enviar and Cancelar CONSUME the record atomically**
  (within the conversation's existing serialization) before any send: a missing, expired or
  already-consumed nonce → `REMINDER_EXPIRED` (consumed and expired are indistinguishable
  without tombstones, which are deliberately not kept — one reply covers both). After Cancelar,
  Enviar on the same card can never send.
- The reassignment re-check (§5/Task-4 ruling) now compares the fresh Jira assignee against the
  RECORD's recipient displayName; the receipt names the record's recipient.

## 6. The DM — fixed template, never free-form

pt-BR, fixed skeleton (exact copy at implementation, tests pin the load-bearing parts):
- who asked: "**<solicitante>** pediu um lembrete sobre o card…" (requester = the Teams display
  name of the person who clicked Enviar);
- the card: bold hyperlinked key + summary + current status (verbatim, from the bound bundle);
- the note, quoted, when present;
- a closing line that replies should go to the requester — the bot does not relay conversations.

The template is the whole message: user text appears only inside the quoted note. The DM never
contains internal Zendesk notes or anything surface-gated (it is a DM to a possibly-uninvolved
person: treat it as `multiparty`).

## 7. Delivery — the seam, and what runs where

Two seams, both faked in tests (`npm test` fully offline, hard rule 7):
- `DirectoryClientLike.searchByName(name)` → Graph implementation.
- `ReminderSenderLike.sendDm(userId, text)` → proactive-conversation implementation (create the
  1:1 via the Azure Bot credentials, post the DM).
- Unconfigured environment (Playground, missing Azure/Graph credentials): the flow runs to the
  end and the send/search step replies **"envio indisponível neste ambiente"** (search:
  "consulta ao diretório indisponível neste ambiente") — testable up to the hop, never silent.
- Success receipt: "lembrete enviado para **<nome>**." Failure: pt-BR error, and the receipt
  never claims success on failure.
- One audit log line per send attempt (requester, target id, card key, outcome) — console for
  now; joins Phase 5 structured logging later.

## 8. Deployment gates (documented honestly; none is code)

1. Azure Bot registration (blocked on IT: rg-jirazen + Contributor — request pending
   2026-09-28) — proactive conversations need real bot credentials.
2. The Teams app installed for the TARGET user (or a Graph proactive-install policy) — a 1:1
   conversation cannot be created otherwise.
3. Graph application permission **User.Read.All** with admin consent on the Jirazen Entra app
   (directory search).

The feature ships dark: fully coded, seam-tested, inert without the credentials. Live
verification happens after the gates open, as an owner-driven session.

## 9. Out of scope (v1)

Email-exact resolution (needs Atlassian user-read scope — upgrade path per §2); reminding
anyone other than the bound card's assignee; scheduled/recurring reminders; delivery through
channels or group chats; relaying replies back; rate limiting beyond one-DM-per-command
(revisit with Phase 5's backoff work); reminder history.

## 10. Testing and acceptance

- Offline: command parsing (with/without note, cap), no-card and no-assignee paths, resolution
  fan-out (1/N/0/error) against a fake directory, clarification card shape, confirmation card
  payload round-trip (Enviar/Cancelar/malformed/expired), DM template content (requester, link,
  status, note, no internal data), unconfigured-environment replies, audit line, receipt
  honesty (failure never reads as success).
- Live, deployment-gated (owner-driven, after §8 opens): resolve a real colleague by name,
  confirm, receive the DM; a homonym clarification; a name not in the org.

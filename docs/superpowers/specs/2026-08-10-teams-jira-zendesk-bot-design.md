# Design Addendum — Teams Card Q&A Bot (Jira + Zendesk + Claude)

> **Status:** approved decisions, 2026-08-10.
> This document **amends** `teams-jira-zendesk-bot-plan (1).md` (the build spec). It resolves that
> plan's **[DECIDE]** items and most **[VERIFY]** items against the live tenant, and records one
> design change to the resolution layer. Where this addendum and the plan conflict, this addendum
> wins. Everything not mentioned here stands as written in the plan.

---

## 1. Resolved decisions (plan §13)

| # | Question | Decision |
|---|---|---|
| 1 | Jira Cloud? | **Confirmed Cloud.** Site `your-tenant.atlassian.net`, REST v3. Integration metadata reports `deployment_type: "Cloud"`. |
| 2 | Zendesk subdomain / `external_id` | Subdomain **`your-subdomain`**. `external_id` = **`00000000-0000-0000-0000-000000000000`** (identical to the Jira cloud id; discovered via `GET /api/v2/integrations/jira`). |
| 3 | Allowed Jira projects | **`AGL, AI, MDO, QZ, SC`** (Agilean, Agilean Insight, Mão de Obra e QQ, QuizQuality, Solicitações CS). These keys also gate the issue-key regex in `parseReference`. |
| 4 | Meaningful custom fields | See §4 below. |
| 5 | Private channels? | Conversations happen in **DMs, small group chats, and standard channels** — no private-channel dependency. Build order (DM first, multiparty second) stands. |
| 6 | Zendesk internal notes | **Include in DMs, suppress in channels.** See §3. |
| 7 | Auth model | **Service account for v1.** Part of the Customer Success team has no Jira account, so per-user OAuth would lock out the bot's primary users. Fetch layer keeps credentials injectable so per-user OAuth can replace the shared credential later without restructuring. Document the visibility implication (every Teams user sees what the service account sees) for whoever approves the app. |
| 8 | Volume | **Moderate: 20–100 cards/day.** Plan defaults (5-min cache TTL, basic 429 backoff) are correctly sized; no extra tuning. |
| 9 | Response language | **Always pt-BR** — answers, card labels, footers, disambiguation prompts. Quoted ticket/issue content stays in its original language. |
| 10 | Bare number default | **Zendesk ticket.** State the assumption in the footer, offer one-tap correction. The no-rebind rule for bare numbers mid-conversation (plan §6.1) stands unchanged. |
| 11 | Real reference habits | Users paste the ticket URL or type `chamado <n>` (e.g. "chamado 11234"). Keyword list is led by **`chamado`**, plus `ticket`, `zd`, `#<n>`; Jira keys (`AGL-123`) are secondary. |

## 2.1 Correction — scoped Atlassian API tokens require the gateway host (amends plan §11/§9)

Live acceptance testing (Phase 1) found that the plan's assumption of Basic auth directly against
`ATLASSIAN_SITE_URL` (`https://your-tenant.atlassian.net`) **does not work with a modern scoped
Atlassian API token**: `GET {ATLASSIAN_SITE_URL}/rest/api/3/myself` returns 401, and issue fetches
return 404 with an unauthenticated-looking "no such issue or no permission" body — easy to
misdiagnose as a missing issue rather than a wrong host.

The working path, verified against this tenant with the same credentials:

```
GET https://api.atlassian.com/ex/jira/{ATLASSIAN_CLOUD_ID}/rest/api/3/myself                 -> 200
GET https://api.atlassian.com/ex/jira/{ATLASSIAN_CLOUD_ID}/rest/api/3/issue/{KEY}             -> 200
GET https://api.atlassian.com/ex/jira/{ATLASSIAN_CLOUD_ID}/rest/api/3/issue/{KEY}/comment     -> 200
GET https://api.atlassian.com/ex/jira/{ATLASSIAN_CLOUD_ID}/rest/api/3/search/jql?jql=...      -> 200
```

Basic auth (`email:token`) works against this gateway host, same as it did (incorrectly) against
the site host — the fix is the host, not the auth scheme. `ATLASSIAN_CLOUD_ID` for this tenant is
`00000000-0000-0000-0000-000000000000` — the same value as `ZENDESK_JIRA_EXTERNAL_ID` (§1 item 2),
but the two remain distinct config values: one is the Jira site's cloud id, the other is how
Zendesk's Jira integration identifies the connection. They are not aliased in config or code.

`ATLASSIAN_SITE_URL` is **not removed** — it remains the display-only host for human-facing Jira
deep links (`{site}/browse/{KEY}`), needed starting Phase 4's Teams cards. It must never be passed
to `fetch()` for the REST API. In code this is `Config.jiraApiBaseUrl` (the URL we call, derived
from `ATLASSIAN_CLOUD_ID`) versus `Config.siteUrl` (the URL we link a human to, from
`ATLASSIAN_SITE_URL`) — future phases must keep that distinction and must not regress `JiraClient`
back to calling `siteUrl`.

## 2. Resolution layer — design change (amends plan §6.2)

### Verified tenant facts

- **Jira remote links are dead on this tenant.** A same-day escalated issue (AGL-1658) has zero
  remote links. Fallback path 2 in plan §6.2 is **deleted**.
- **Jira has a "Zendesk ID" custom field: `customfield_10356`** (short text, holds the bare Zendesk
  ticket id). Coverage: of 760 `jira_escalated` issues in the allowed projects, 677 (~89%) have it
  populated. Gaps are not purely historical — a few issues from the last month lack it.
- **Reverse lookup works and is exact:** JQL `cf[10356] ~ "16560"` returns exactly the linked issue
  (verified pair: Zendesk ticket 16560 ↔ AGL-1658 / issue id 42502).
- **The links API is currently blocked:** both the modern endpoint
  (`/api/v2/integrations/jira/{external_id}/links`) and the legacy ones (`/api/v2/jira/links`,
  `/api/services/jira/links`) return **403** with a working API token. Expected cause: the
  "Manage links" toggle in Zendesk Admin Center → Apps and integrations → Integrations → Jira.
- **Escalations appear to be created by a custom script, not the native app flow.** Ticket 16560
  carries an `n3_script` tag and *no* `jira_escalated` tag, while its Jira issue has the
  `jira_escalated` label and a populated Zendesk ID field. Consequence: even after "Manage links"
  is enabled, the links API **may be empty** — the custom field may be this tenant's actual source
  of record.

### Resolver design

One `Resolver` interface, two interchangeable strategies, priority order set by config
(`RESOLVER_ORDER`):

- **Strategy A — Zendesk links API.** Both directions via
  `GET /api/v2/integrations/jira/{external_id}/links?ticket_id=…|issue_id=…`. Handles one-to-many.
  Authoritative *if populated*.
- **Strategy B — Jira "Zendesk ID" field.** Jira→Zendesk: read `customfield_10356`.
  Zendesk→Jira: JQL `cf[10356] ~ "<ticket_id>" AND project in (<allowed>)`. Pure Jira-side, no
  Zendesk links permission needed. Limitation: one ticket id per issue, so many-to-many links are
  invisible to it; a JQL search returning multiple issues is still surfaced as a multi-match.

The resolver tries strategies in configured order; each returns the same typed result
(`resolved | ambiguous(candidates) | not_found`), and the winning strategy is recorded in
`resolution.via` (values become `'zendesk_links' | 'jira_zendesk_id_field'`). The default order is
decided by the Phase 0 finding once "Manage links" is enabled: links-API-first if it has data,
field-first if it is empty. **Re-verified during Phase 1 live acceptance testing: the links probe
still returns 403** ("Manage links" remains disabled), so the current default is
**field-first** (`RESOLVER_ORDER=jira_zendesk_id_field,zendesk_links`, §6) until that admin task
lands (§7 item 1). The `jira_escalated` label remains a weak existence hint only.

## 3. Internal notes and the `surface` flag (amends plan §8/§7.2)

The bundle assembler takes `surface: 'dm' | 'multiparty'`:

- `dm` → Zendesk comments include internal notes (flagged as internal, per plan §7.3).
- `multiparty` → internal notes are omitted entirely (not redacted in place — omitted, with a
  bundle-level note that internal notes were excluded so the model can disclose the gap).

Because the two variants render different prompt prefixes, **the prompt-cache key and the
`bundleCacheKey` both include the surface flag.**

## 4. Jira field whitelist (resolves plan §8.2 [DECIDE])

Plan §8.2 base list, plus the tenant's custom fields below (verified populated on real escalated
cards, e.g. QZ-252). Null fields are dropped at render time, so whitelisting liberally is cheap.

| Field (pt-BR label as rendered) | Id | Why |
|---|---|---|
| Zendesk ID | `customfield_10356` | The link itself; always render. |
| Root cause | `customfield_10070` | ADF rich text — explains the underlying cause. Highest-value field for support Q&A. |
| Workaround | `customfield_10071` | ADF rich text — what to tell the customer while a fix is pending. |
| Diagnóstico | `customfield_10320` | ADF rich text — diagnosis notes. |
| Development | `customfield_10000` | PR status JSON (e.g. "1 PR — MERGED"); answers "has the fix been merged?". Needs a small bespoke condenser, see below. |
| Tipo de incidente | `customfield_10389` | Incident classification (Bug / Solicitação / …). |
| Bloqueado | `customfield_10322` | Blocked flag — common status question. |
| Correção Definitiva | `customfield_10321` | Definitive-fix flag. |
| Classificação QA | `customfield_10622` | QA classification (e.g. "Regressivo recorrente"). |
| Origem do Defeito | `customfield_10756` | Defect origin (e.g. "Desenvolvimento"). |
| Quantidade de vezes "Reprovado" | `customfield_10210` | QA rejection count. |
| Tester | `customfield_10114` | Who validates — complements assignee. |
| Feature afetada | `customfield_10319` | Affected feature. |
| Motivo de contato | `customfield_10318` | Contact reason. |
| Problema | `customfield_10656` | Problem link/description. |
| Critérios de Aceite | `customfield_10284` | Acceptance criteria. |
| Zendesk Status / Prioridade Zendesk | `customfield_10206` / `customfield_10207` | Mirrored Zendesk state (low value — live Zendesk data supersedes; keep for cross-checks). |
| Clientes | `customfield_10106` | Affected customers. |
| Sprint | `customfield_10010` | Already in plan's base list. |
| Time tracking | `timetracking`, `aggregatetimespent`, `timeoriginalestimate` | Estimates and time spent — see §5. |

Render with the human labels above, never raw `customfield_*` ids. The whitelist lives in config so
fields can be added without code changes. Two implementation consequences:

- **ADF conversion applies to custom fields too** (`Root cause`, `Workaround`, `Diagnóstico`,
  `Critérios de Aceite` are ADF documents), not just description and comments (extends plan §8.4).
- **`Development` needs a condenser:** parse the field's embedded JSON into a one-line summary
  ("1 pull request — MERGED, atualizado 2026-08-10"); never pass the raw blob to the prompt.

## 5. Jira Q&A scope confirmation (clarifies plan §8)

Explicitly in scope — questions about the Jira issue itself, answered from the base bundle without
tool calls: full comment history (including Automation-for-Jira workflow narration), status history
with durations, assignee changes, time estimates and time spent, due date, priority,
labels/components, resolution, root cause, workaround, PR/merge status. Two amendments serve this:

- The condensed changelog (plan §8.3) includes **assignee transitions** as well as status
  transitions.
- Time-tracking fields join the whitelist (§4 above).

Worklog detail, linked issues, attachment metadata, and sibling Zendesk tickets stay tool-gated
(plan §7.4) as designed.

## 6. Tenant constants (updates plan §11 env table)

```
ATLASSIAN_SITE_URL=https://your-tenant.atlassian.net   # display-only: browse-link host, never called
ATLASSIAN_CLOUD_ID=00000000-0000-0000-0000-000000000000    # API gateway host is derived from this (§2.1)
ATLASSIAN_ALLOWED_PROJECTS=AGL,AI,MDO,QZ,SC
ZENDESK_SUBDOMAIN=your-subdomain
ZENDESK_JIRA_EXTERNAL_ID=00000000-0000-0000-0000-000000000000
RESOLVER_ORDER=jira_zendesk_id_field,zendesk_links   # field-first; links API confirmed still 403 (§7 item 2)
JIRA_ZENDESK_ID_FIELD=customfield_10356
```

Secrets (tokens, keys) go in a gitignored `.env` locally and Key Vault in Azure — never in this
repo. **The Zendesk API token used during discovery was pasted into a chat log and must be
rotated** once Phase 0 credentials are properly stored.

## 7. Remaining Phase 0 items (shrinks plan §12 Phase 0)

Discovery completed during design: Jira Cloud confirmed; `external_id` found; projects chosen;
custom fields enumerated with names; remote links ruled out; Zendesk ticket + comments read access
verified (HTTP 200); a known-linked pair identified (ticket 16560 ↔ AGL-1658, issue id 42502);
links API blocked with 403 pending admin action.

Still open:

1. **Admin task:** enable "Manage links" in Zendesk Admin Center → Apps and integrations →
   Integrations → Jira.
2. ~~Re-test the links API in both directions; record whether it is populated → sets
   `RESOLVER_ORDER`.~~ **Answered during Phase 1 live acceptance testing:** the links probe
   returned **403** again — "Manage links" is still disabled, so the field strategy
   (`jira_zendesk_id_field`) stays primary. `RESOLVER_ORDER=jira_zendesk_id_field,zendesk_links`
   is now the shipped default (§6); re-open this item once item 1 lands and re-probe.
3. Record scrubbed fixture responses (Jira issue + changelog + comments, Zendesk ticket + comments,
   links API if available) into `test/fixtures/`.
4. Rotate the Zendesk API token; provision the Jira service account + token scoped read-only to the
   five allowed projects.

## 8. MVP scope — DM only, card interactions as text commands (amends plan §9.1/§9.4/§12)

**Decided 2026-08-12.** The minimum viable product is the **DM surface only**. Plan §12's
Phase 4 (multi-party chat, @mention handling, thread/group binding, Adaptive Cards, link
unfurling) is **deferred in full** until the DM bot has been used in anger.

This follows the plan's own sequencing rather than departing from it — §9.2 already ranks DM
first ("Build and ship this first; it is the surface where free-form Q&A actually feels
conversational") and Phase 3 is already specified as DM-only. The decision is where to
**stop**, not how to order the work.

### What ships

Phase 3 (DM bot) plus the parts of Phase 5 that a production DM bot needs: rate-limit
backoff, Key Vault wiring, and structured logging with token accounting. The four bounded
tools (plan §7.4) stay optional. The disambiguation *card* becomes a plain-text list — the
assembler already returns typed candidates, so nothing new is required to render it.

### Nothing built so far is wasted

The `surface: 'dm' | 'multiparty'` flag is already implemented in the bundle assembler and
prompt cache key (§3). `multiparty` simply stays unexercised until Phase 4; no rework is
needed to switch it on.

### Card interactions ship as text commands — explicitly temporary

Adaptive Cards provide three interactions this MVP would otherwise lose. Each gets a text
equivalent, and **each is a placeholder to be replaced by the card affordance when Phase 4
lands** — not a permanent design:

| Card affordance | Temporary text command | Replaced by |
|---|---|---|
| Refresh button (plan §7.5, a *required* staleness mitigation) | User types `atualizar` → refetch and rebind | Refresh action on the card |
| One-tap correction after a bare-number assumption (plan §6.1) | Bot states the assumption; user types `AGL-123` or `#4471` to rebind | Correction action on the card |
| Disambiguation picker on a multi-match (plan §6.2) | Bot lists numbered candidates; user replies with the number or the key | Disambiguation card |

Everything else a card would convey survives in plain text: deep links to Jira and Zendesk
render as markdown links in Teams messages, the bound-card footer (plan §9.3) is a text line,
and field values render as markdown bullets. Only *tables* genuinely require a card.

**Do not treat the text commands as the long-term interface.** They exist so the DM MVP keeps
the plan's full staleness and disambiguation discipline without card infrastructure. When
Phase 4 ships cards, the commands should remain as aliases (typing is natural in a DM) but
the buttons become the primary affordance.

A side benefit worth keeping: plain text is materially easier to test than cards — no
rendering variance between the M365 Agents Playground and a real tenant, and assertions are
straightforward string checks.

### Acceptance for the MVP

In a 1:1 chat: reference a card by `QZ-252` or `chamado 16467`, get a grounded pt-BR summary;
ask three follow-ups without re-referencing it; switch cards explicitly; confirm a bare number
mid-conversation does **not** rebind (plan §6.1); type `atualizar` and get fresh data with a
new `fetched_at`.

### Internal notes in a DM-only MVP — resolved

§3 decided internal Zendesk notes are included in DMs and suppressed in channels. With DM as
the only surface, that means every user of the MVP sees internal notes, which can contain
customer PII.

**Resolved 2026-08-12: this is acceptable and intended.** The DM surface is used exclusively
by Agilean staff, who are already entitled to read agent-only notes in Zendesk itself. The bot
therefore widens *convenience*, not *audience* — it surfaces content these users could already
open the ticket to read.

The channel suppression in §3 stands unchanged and is not redundant: it remains the guard for
Phase 4, where a conversation can include participants who are not Zendesk agents. Do not
remove the `multiparty` branch on the grounds that the DM case made it unnecessary.

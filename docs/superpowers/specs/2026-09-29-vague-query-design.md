# Vague queries — empresa/cliente/obra search, disambiguation, and portfolio rundown

**Date:** 2026-09-29
**Status:** approved design (initial testing scope)
**Depends on:** Phases 1–4. Ships after the answer-quality phase
(`2026-09-29-answer-quality-design.md`).

## 1. Goal

Non-technical members ask vague questions — "qual o status da empresa Y?", "como está a obra Z?" —
and today get the generic help text. This phase adds a search path that finds the active cards
behind such a question and either disambiguates ("which of these did you mean?") or answers with a
portfolio rundown, without disturbing the one-card conversation model.

## 2. Measured reality that shaped this design (probes, 2026-09-29)

- The Jira fields that *look* right (`Clientes` cf10106, `Cliente` cf10488, `Organizations`
  cf10004) are populated on **0 of 760 active cards** across the five allowed projects. A field
  filter finds nothing.
- Cliente/empresa/obra live in free text: the support template lines inside descriptions
  ("Organização: …", "Nome da obra: …") and summaries.
- Zendesk, by contrast, has real organizations: every ticket carries `organization_id`.

Hence the hybrid: **empresa/cliente resolves through Zendesk organizations; obra through Jira
text search.** If the Jira fields ever start being populated, a field strategy can be added in
front — the search layer is strategy-shaped like the existing resolver.

## 3. Routing — the detector can never steal a genuine question

Priority order in `handleMessage` for a non-command message:

1. **Binding exists → unchanged.** Every non-command, non-reference message goes to the bound
   card exactly as today. Free-form questions are never intercepted.
2. **No binding + parseable card reference → unchanged** (binds and summarizes).
3. **No binding + portfolio pattern → the new search path.** Deterministic detector (regex/
   keyword, `parseCommand` style): a name plus a portfolio marker ("status/andamento/como está"
   × "empresa/cliente/obra/projeto"), or bare "empresa X" / "obra Y".
4. **Anything else → help text, as today** (now also mentioning `buscar`).

The detector therefore only ever replaces the help-text outcome: a false positive costs a search
attempt instead of help; a false negative costs the help text the user would have received anyway.

**Explicit command:** `buscar <nome>` triggers the search path anytime — including inside a
conversation with a bound card (it does not unbind unless the user then selects a result).

## 4. Search

Both searchers are GET-only (hard rule 1 holds) and strategy-shaped.

- **Empresa/cliente → Zendesk organizations.** Name match via the organizations autocomplete
  endpoint (cap 5 orgs). One org → its open/pending tickets (cap 25) → mapped to Jira via the
  existing resolver where a counterpart exists (tickets without one still appear, Zendesk-only).
  Multiple orgs → org-level disambiguation first.
- **Obra (and fallback when Zendesk finds no org) → Jira text search.** JQL
  `text ~ "<nome>" AND project in (<allowed>) AND resolution is EMPTY ORDER BY updated DESC`,
  cap 25. Text search is noisy by nature, so its results are ALWAYS presented as candidates or a
  rundown — the bot never silently binds a text-search match, even a single one. (A single
  *organization* match with a single ticket may bind directly: that path is structured, not
  fuzzy.)

## 5. Disambiguation and selection — by name and by button

- Candidates render as an Adaptive Card: one line per candidate (key/org, one-phrase summary,
  status) plus **one `Action.Execute` button per candidate** (new verb, constant derived the same
  way `REFRESH_ACTION` is, payload carrying the selection). Up to 6 buttons; beyond that the card
  says "e mais N — refine o nome".
- Clicking a card button binds that card (normal binding semantics, thread/personal rules
  unchanged) and answers with the standard summary.
- Typing also selects, matched by **name or key** — never by list position/number. The match runs
  against the candidate set the bot just showed (stored alongside the binding slot with the same
  24h lifetime); an ambiguous typed name narrows the candidate card instead of failing.

## 6. Portfolio rundown — deterministic, no generation step

When the question is portfolio-shaped ("como estão as coisas da empresa Y"), the bot answers with
a rundown **rendered directly from the search results — no Claude call**:

```
**Empresa Y — 6 cards ativos (coletado às HH:MM)**
• QZ-311 — Erro no relatório de avanço — Em Teste, atualizado 25/09
• AGL-1892 — Reprogramação exclui atividades — Em Desenvolvimento, atualizado 24/09
… (até 8 linhas; depois "e mais N cards — pergunte por um deles")
```

- Fields shown are verbatim API values (key, summary, status name, updated date, Zendesk subject/
  status for unlinked tickets). There is no generation step, so fabricated content is structurally
  impossible — the residual risk is truthful-but-stale data, which the coletado-às label carries.
- Ordering: least-recently-updated first is rejected (buries the news); most-recently-updated
  first, with a trailing "parado há mais tempo: <key>, sem atualização desde <data>" line when
  the oldest card is >14 days stale.
- A rundown never binds. Selecting/naming one of its cards afterwards binds it (via §5's typed
  match or a normal reference).

## 6a. Query weight budget (owner requirement, 2026-09-30)

Searches must stay lightweight to avoid bottlenecks and vendor rate limits:

- One search costs **at most 3 HTTP GETs** (org autocomplete → org tickets → one batched
  Zendesk-id JQL); the text path costs 2. No per-ticket resolver calls, ever.
- First page only, results capped at the source (5 orgs / 25 tickets/cards), responses
  field-limited to what the rundown shows.
- **No client-side retries** in the search path: a 429/5xx becomes the pt-BR unavailable reply
  immediately (systematic backoff remains Phase 5).
- The orchestrator memoizes outcomes per normalized name for **60 seconds**, so an identical
  repeated search (a retry, or a second person in the channel) costs zero vendor calls.

## 7. Surfaces, budget, failure modes

- **Multiparty-safe:** rundowns and candidate lists contain only subjects, statuses and dates —
  never internal note content — so the same rendering serves DM and channel.
- **No token budget concerns:** search results never enter a Claude prompt; the single-card flow
  keeps its existing budget.
- **Every path replies** (hard rule 3): zero matches → "não encontrei cards ativos para <nome>"
  plus the search-refinement hint; Zendesk/Jira search errors → the existing pt-BR error replies.
- Search result caps: 5 orgs, 25 cards fetched, 8 rundown lines, 6 buttons.

## 8. Testing

- Offline (fixtures, no network): detector (portfolio patterns vs. free-form questions vs.
  references — including the binding-exists guarantee of §3.1), both searchers against captured
  fixtures, disambiguation card construction, typed-name selection, rundown rendering (caps,
  omissions, stale flag), `buscar` command.
- The grounding eval is untouched — no Claude behavior changes in this phase.
- Live: one Playground session (owner-confirmed) exercising empresa search, obra search,
  disambiguation buttons, and the rundown; plus `npm run fixtures`-style capture of organization
  search payloads to build the offline fixtures (owner-confirmed, GET-only).

## 9. Out of scope (initial testing)

LLM-based intent classification, cross-card Claude answers ("summarize these 6 cards"), resolved-
card history search, Zendesk organization creation/edits of any kind (writes stay forbidden), and
persisting candidate sets beyond the binding store's lifetime.

## 10. Addendum — live-session findings (2026-09-30, owner screenshots)

1. **Detector anchors widened.** "como estão os cards da Dalle?" / "as atividades da dalle?"
   missed the detector (no empresa/cliente/obra/projeto anchor). Plural subject words become
   portfolio anchors — cards, atividades, chamados, tickets, pendências, demandas — always
   mode 'rundown'. The singular defect words keep flipping mode to 'candidates' as before.
2. **Rundown renders as an Adaptive Card** (fallbackText keeps the plain-text render): bold
   count title; per card a line `**KEY** — summary` plus a subtle line
   `status · responsável · atualizado DD/MM` with the status TextBlock colored — `good` for
   concluded states (done, pronto para produção, resolvido), `attention` for blocked/reprovado,
   default otherwise (small exported mapping, tenant-tunable). Rundowns still never bind and
   carry no buttons; typed selection keeps working via the stored set.
3. **Assignee joins the search results** where it costs nothing extra: `assignee` added to the
   fields of both Jira search queries (same single requests); `CardCandidate.assignee?: string`;
   shown when present, omitted for Zendesk-only lines (a users lookup would break the §6a budget).
4. **Sectioned company card (owner, 2026-09-30):** the rundown/candidate card splits into two
   sections — "Cards (Jira)" and "Chamados (Zendesk)" — each omitted when empty. Jira lines show
   their Zendesk pair when known: `**QZ-310** ↔ chamado 17058 — <summary>`. The pair id comes from
   the existing batch mapping, and `searchActiveByText` additionally requests the Zendesk-id
   custom field so text-search results pair too (same single request; §6a intact). The plain-text
   fallback mirrors the grouping. Labels, buttons and typed selection are unchanged.
5. **Card prominence + actionable overflow (owner, 2026-09-30, round 3):** the company card's
   title uses the MATCHED organization's real name (e.g. "DALLÉ CONSTRUTORA") when the org path
   resolved — the typed query only for text search — rendered prominent (Large/Bolder), never
   subtle. Section headers are bold, default size, with separators. Paired lines bold the whole
   pair: `**QZ-306 ↔ chamado 17044** — summary`. The overflow line names the remaining
   candidates' labels (`e mais 2: QZ-298, chamado 16694`) so every card is reachable by typing —
   never an unanchored "pergunte por um deles".
6. **Round 4 (owner, 2026-09-30):** name extraction also strips na/no/nas/nos/em connectives
   ("atividades no Jardins…"). Headers count "atividades abertas", not "cards ativos"
   ("25+ atividades abertas (mostrando as mais recentes)" at the cap). Every key and chamado —
   section lines, pair halves, overflow labels — renders as a bold markdown LINK via the existing
   jiraLink/zendeskLink helpers (renderers gain cfg). Overflow moves INTO each section: a
   per-section "e mais N: <links>" line naming that section's hidden items (global display cap
   unchanged; the stale line stays card-global). The plain-text fallback mirrors all of it.

# Portfolio follow-ups — expand, statistics, and grounded multi-card answers

**Date:** 2026-09-30
**Status:** approved design
**Depends on:** the vague-query phase (candidate store, search orchestrator, sectioned cards).

## 1. Goal and scope decision

After a company/obra rundown, follow-ups today fall to help text. This phase makes the bot
"ready to answer" the questions a person actually asks next — statuses, counts, responsibles,
recency, business-insight reading of the same data — without new vendor calls.

Owner decision (2026-09-30): build option 2 (deterministic follow-ups + Claude answers over the
portfolio) **on option-3-ready architecture**: a first-class portfolio context, with free-form
routing to it enabled only where it is provably safe (no card bound). The remaining option-3
step — free-form portfolio Q&A *while a card is also bound* — stays a future routing decision.

## 2. The portfolio context

Promotes the stored candidate set to a context object (same store, richer content, same shared
slot + 24h lifetime; replaced by every new search; NOT cleared by a card bind — the two coexist):

- `displayName`, the candidates (ref, label, summary, status, assignee?, zendeskId?, updatedAt),
  `collectedAtMs`.
- **A deterministic aggregates block, computed in code at store time:**
  - counts by status (exact strings as the APIs returned them);
  - counts by assignee (plus "sem responsável");
  - per-section totals (Jira / Zendesk) and the overall total, with the 25-cap flag;
  - stale list (> STALE_AFTER_DAYS without update) and most/least recently updated items.
- `renderPortfolio(context)` renders it as prompt text: the aggregates block FIRST (labeled,
  e.g. `[estatísticas]`), then one line per candidate with its label as the citation anchor
  (`[QZ-306]`), then `coletado às`. Bounded by construction (≤ ~25 lines + aggregates), so no
  token budgeting machinery is needed; assert a sane ceiling in tests.

## 3. Routing (extends the vague-query decision table; all guarantees preserved)

Priority for a non-command message, updated:

1. Binding exists → the bound card wins ALL free-form text, exactly as today. While a card is
   bound, the portfolio is reachable ONLY via the explicit follow-up patterns (§4) and `buscar`.
2. No binding + portfolio context active → free-form text goes to **Claude-over-portfolio**
   (§5). This replaces an outcome that today is help text, so the same safety argument as the
   detector applies: worst case is a grounded answer about the portfolio instead of help text.
3. No binding + no portfolio → unchanged (reference / detector / help).

Typed selection, buttons, `buscar`, and rebind-clears semantics are unchanged; a card bind does
not delete the portfolio context (rejoining it after `voltar`-style flows stays possible).

## 4. Deterministic follow-ups (zero tokens, exact)

Pattern-matched (parseCommand style, offline-tested) and answered from the context, no Claude:

- **Section expand:** "todos os de jira", "todos os de zendesk", "mostra tudo" → the sectioned
  card re-rendered with the requested section(s) uncapped (buttons still capped).
- **Quick counts:** "quantos(as)?" alone or with a status word ("quantos pendentes/abertos/
  bloqueados/concluídos") → a small text reply from the aggregates block (exact numbers,
  including the "25+" caveat when capped).

These run in step 1 (bound) and step 2 (unbound) alike — they are explicit patterns.

## 5. Claude-over-portfolio (grounded multi-card answers)

- A second prompt (`PORTFOLIO_SYSTEM_PROMPT`, sharing the grounding DNA of the card prompt):
  answer ONLY from the rendered portfolio; cite candidate labels bracketed (`[QZ-306]`,
  `[chamado 17063]`) and the aggregates block as `[estatísticas]`; **never count or derive
  numbers — every number in an answer must come from the aggregates block verbatim**; admit
  gaps ("o contexto não mostra X — abra o card para detalhes"); pt-BR; the same Adaptive Card
  style contract (bold lead, ≤6 lines, hyphen bullets); collection time lives in the reply
  footer, not the text.
- Answer path: `answerPortfolio(context, question, history)` mirroring `answer()` (same model,
  effort low, cache breakpoint on the rendered context with the 1h TTL — context lifetime is
  the search-cache + store lifetime, so repeated follow-ups hit the cache).
- Follow-up history: kept on the portfolio context like binding history (MAX_HISTORY_TURNS).
- Replies render as cards with a portfolio header (displayName + coletado às) and the existing
  Atualizar-like affordance deferred (no refresh button on portfolio replies in this phase —
  a new `buscar` refreshes naturally).
- Citation display compression: candidate labels are already short; the existing
  `compressCitations` must pass portfolio citations through unharmed (`[QZ-306]` matches no
  pattern — verified by test); `[estatísticas]` likewise.

## 6. Eval additions (grounding the new mode)

- A synthetic portfolio fixture (≈8 candidates, two sections, mixed statuses/assignees, one
  stale item, known aggregates).
- New eval cases (category `portfolio`): counts by status and by assignee must contain the
  aggregates' exact numbers (`mustContain('3')`-style plus judge criteria); a
  not-in-context refusal ("qual o prazo do QZ-306?" → admit the context has no such detail and
  point to the card); mustNotInventDate over the fixture; a summary question obeying the style
  rules (mustLeadWithBold, maxLines); citation-form checks reusing mustCite with candidate
  labels.
- Baseline/final live-run discipline exactly as the answer-quality phase (owner-gated runs; no
  regression on the existing 33 cases; new portfolio cases pass).

## 7. What does NOT change

The one-card binding model and every vague-query routing guarantee; the search clients and the
§6a query budget (this phase adds ZERO vendor calls — everything reads the stored context); the
card-answer prompt and its eval cases; read-only, never-silent, pt-BR, SDK-only-in-app.ts.

## 8. Testing and acceptance

- Offline: aggregates computation (counts, stale, caps flag), renderPortfolio shape + ceiling,
  follow-up patterns (incl. NOT firing on bound-card free-form text), routing precedence
  (bound-card-wins pinned again), compressCitations passthrough, prompt tests for
  PORTFOLIO_SYSTEM_PROMPT's load-bearing strings.
- Live (owner-gated): eval baseline+final runs; a Playground session — rundown → "quantos por
  responsável?" → "resume a situação" → expand section → bind a card → confirm free-form goes
  to the card while "quantos abertos?" still answers from the portfolio.

## 9. Out of scope (the remaining option-3 step, plus)

Free-form portfolio Q&A while a card is bound (needs its own precedence design); portfolio
refresh button; cross-portfolio comparisons ("Dallé vs Norte"); persisting portfolio contexts
beyond the in-memory store.

## 3a. Context switching (owner requirement, 2026-09-30)

Users hop contexts rapidly — company A → project B → follow-up on B → company C. Rules:

- **The detector (and `buscar`) precede Claude-over-portfolio** in the unbound path: a
  portfolio-shaped question naming an entity ALWAYS runs a new search, replacing the context
  (one context per shared slot; last search wins). Follow-up history resets with the new
  context.
- A follow-up WITHOUT an entity name ("e quantos estão bloqueados?", "resume") never matches
  the detector (it requires anchor + name) and stays on the current context — that is what
  makes "follow-up on B" work right after switching to B.
- Re-asking a recent entity ("e a Dallé de novo?") is just a new search: the 60-second memo
  makes back-and-forth switches free, and beyond it the §6a budget (≤3 GETs) keeps them cheap.
  No multi-context store — sequential replacement covers the flow.
- Bound-card precedence is unaffected: all of this lives in the no-card-bound path.

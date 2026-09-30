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

## 10. Addendum — live-session findings (2026-09-30, owner screenshots)

1. **Status aggregates split by system.** Jira and Zendesk use different status nomenclatures
   (Pronto para Delivery/Done/Blocked vs open/pending), so a single global `por status` list in
   `[estatísticas]` reads as noise. `PortfolioAggregates.byStatus` becomes two lists —
   `jiraByStatus` and `zendeskByStatus` — rendered as separate `- por status (Jira): …` /
   `- por status (Zendesk): …` lines (each omitted when its system has no items).
   `renderCounts` status-marker sums run across both lists; `por responsável` stays global
   (names are shared across systems; Zendesk items keep falling into "sem responsável").
2. **Expand patterns accept natural fillers.** "quero ver todos os de zendesk" fell through to
   Claude and produced prose instead of the sectioned card. `parseFollowup` expand forms gain an
   optional leading filler (quero/queria [ver], me mostra/mostre, mostra/mostre/mostrar, ver,
   exibe/exiba, lista/liste/listar) and accept `de`/`do`/`da` before the section name. Still
   whole-message anchored — a sentence merely containing the words passes through.
3. **Deterministic distribution cards.** "me mostra por status" / "divide por responsável" become
   deterministic follow-ups (`kind: 'distribution'`, dimension status|assignee) instead of Claude
   calls: whole-message patterns of optional filler + optional verb (divide/divida/distribui/
   distribuição/quantos) + `por status` / `por responsável|responsáveis`. The reply is an
   Adaptive Card in the rundown family: prominent org name + coletado às; for **status**, the
   two bold sections (Cards (Jira) / Chamados (Zendesk), omitted when empty) with one line per
   status — colored via the existing `statusColor` map — `Status — N:` plus that bucket's keys
   as bold hyperlinks, capped at SECTION_LINE_CAP keys with `e mais N`; for **responsável**, a
   single sectionless list in the same line shape. Plain-text fallback mirrors. Exact numbers
   come from the same aggregates, so the never-count guarantee holds; Claude keeps everything
   that doesn't match these patterns, now over the sectioned stats block.

4. **Bare-name status questions (owner edge case, screenshot 09:50).** "qual o status da
   dalle?" reached NOTHING_BOUND: the detector demanded an entity word (empresa/obra/…) or a
   plural subject, and "da dalle" has neither. New whole-message-anchored loose shapes in
   `detectPortfolioQuery`, mode `rundown`:
   - `qual (é|e|eh)? (o|a) (status|andamento|situação) (atual)? d[aeo](s)? <nome>`
   - `como (está|estão|anda|andam) (o|a|os|as)? <nome>`
   Guards: the existing STOP_NAMES check; the tail must not be reference-shaped (a Jira key,
   `chamado N`, `#N`, a bare number, or a URL) so card questions keep their current path; the
   existing anchored patterns win first (they can classify `candidates`). These shapes fire only
   where the detector already runs (never with text a bound card owns), so the §3 safety
   argument is unchanged — worst case is one failed search where help text stood.
   **Final-review amendment (2026-09-30):** the loose shapes fire ONLY when no portfolio
   context is stored. With one stored, phrases like "como estão os bloqueados?" are follow-ups
   §3a guarantees stay on the current context, and letting a loose shape search would replace
   the context with a junk set (last-search-wins + history reset). Mid-conversation switching
   remains available through the anchored shapes ("empresa norte", plural anchors) and `buscar`;
   the loose shapes serve the cold-start state the owner's screenshot showed.

## 11. Addendum — confirm-to-switch while bound (owner decision, 2026-09-30)

Resolves the §9-deferred routing question after the owner hit it live ("como estao as atividades
da dalle?" with a card bound went to the card, which could only say the bundle has no Dallé).

- While a card is bound, a free-form message that matches the detector's **anchored** shapes
  (entity word or plural subject + name — never the loose §10.4 shapes, which stay cold-start
  only) no longer goes to the bound card directly. The bot replies with a small confirm card:
  "**Você quer ver as atividades de <nome>?**" with two `Action.Execute` buttons —
  `Buscar <nome>` (runs the search exactly as the typed `buscar <nome>`: same slot semantics,
  does not unbind unless the user then selects) and `Continuar no <card label>` (sends the
  ORIGINAL message text to the bound card's answer path, so the user never retypes).
- Rationale: bound-card-wins existed because entity words match mid-sentence and genuine card
  questions ("o problema da obra Flora persiste?") must not be silently stolen. The confirm card
  makes a false positive cost one click in either direction and keeps every path non-silent.
  Such a mid-sentence match SHOWING the interstitial is accepted behavior, pinned in tests.
- Everything that already worked while bound is unchanged and keeps precedence: commands,
  `buscar`, follow-up patterns (`quantos?`, expand, distribution), exact-label selection,
  references. The confirm card slots in where "bound card wins free-form" was the final answer.

### 11.1 Loose shapes join the confirm path (owner screenshots 10:33, 2026-09-30)

"Qual o status da Flora?" while bound went straight to the card: §11 allowed only ANCHORED
shapes, a ruling made before the confirm card existed, when a false positive meant silently
stealing the question. The interstitial changes the cost of a false positive to one click, so:

- The bound-state fallthrough now runs the detector WITH the loose shapes
  (`allowLoose: true`). Loose matches raise the same confirm card. The §10.4 cold-start gate is
  unchanged for the UNBOUND path (with a portfolio stored, free-form still goes to
  Claude-over-portfolio, which can genuinely answer about items inside the context).
- New loose shape (all the usual states/gates): `quero (saber|ver) [mais] (sobre|de|do|da|dos|das)
  <nome>` — "quero saber sobre a Flora". No leading-negation handling: "não quero saber sobre X"
  must not match, so the shape is anchored at `^quero`.
- **Generic-tail guard** on ALL loose shapes, every state: a name that is a bare generic noun is
  a question about the current work item or an underspecified query, never a switch. Exported,
  tenant-tunable stop set (normalized, singular+plural where sensible): card, chamado, ticket,
  atividade, projeto, obra, empresa, cliente, organizacao, incidente, problema, erro, bug, prazo,
  status, andamento, situacao, historico, responsavel, descricao, resumo, resto, resultado,
  pendencia, demanda, tudo, isso, ele, ela, eles, elas. Multi-word names are exempt (the guard
  applies to single-token names only: "obra flora" is a name, "obra" is not).

### 11.2 Move-on semantics and vocabulary-aware switching (owner screenshots 10:43–10:45)

Three connected findings from the live session:

- **The confirm card's `Buscar <nome>` button UNBINDS the current card.** The bot asked "switch
  or stay?" and the user chose switch; keeping the binding made every later question re-raise
  the interstitial. Typed `buscar` keeps its §3 semantics (no unbind) — the click differs
  because it answers an explicit question.
- **The confirm card's search preserves the detected mode.** The §10.4/§11.1 shapes are overview
  questions (mode `rundown`); forcing `candidates` mode gave the owner an unexpected
  button-heavy card. The button payload carries the mode; typed `buscar` stays `candidates`.
- **Loose shapes switch on real names even with a portfolio stored** — superseding the §10.4
  cold-start-only gate. After moving on, "como esta jardins de potengi?" must search jardins,
  not ask Claude about Flora. The §3a protection ("como estão os bloqueados?" stays on context)
  is preserved by a **portfolio-vocabulary filter** instead of the blanket gate: a loose-shape
  name is a follow-up, not a switch, when it normalizes to portfolio vocabulary — any
  `STATUS_FILTER_MARKERS` key, any status string present in the stored set, any stored assignee
  (full name or first token), or `GENERIC_TAILS` (global). Vocabulary matches keep today's
  outcome (Claude-over-portfolio unbound; the bound card while bound — no interstitial for
  vocabulary tails there either). Non-vocabulary loose names: unbound → new search (context
  switch); bound → the §11 confirm card. `PortfolioQuery` gains a `loose` flag so the caller
  can apply the filter; the detector stays pure.

## 13. Addendum — candidate-card affordances and distribution verbs (same session)

- **Candidates overflow names its items:** "mais 4 sem botão — digite o nome" says nothing.
  Replace with the §10.5 pattern: `e mais 4 — digite o nome: <label links>`, listing the
  candidates that did not fit a button.
- **Distribution verbs widened:** organiza/organizar/organize, agrupa/agrupar/agrupe,
  separa/separar/separe join the §10.3 verb set — "organize por status" is a distribution
  request, not free-form text ("organize" reached the bound card's Claude live).

## 12. Addendum — help-text rendering fixes (owner screenshots, 2026-09-30)

`buscar <nome>` rendered as literal `&lt;nome&gt;` in Teams, and the **Comandos** lines collapse
into one flowing paragraph (single `\n` is not a line break in Teams markdown). Drop the angle
brackets (pt-BR phrasing without `<>`), and separate command lines so each renders on its own
line.

## 5a. Selection tightening (consequence of §5, controller-ruled)

Once free-form text over a portfolio reaches Claude, substring-based typed selection would steal
questions ("o que está bloqueado?" matching a summary). Typed selection therefore becomes
exact-label-only in ALL states (the vague-query behavior where nothing consumed unbound text no
longer exists); ambiguity never blocks — unmatched text falls through to Q&A or the bound card.
Every candidate stays reachable: buttons, exact labels, and Jira/chamado keys.

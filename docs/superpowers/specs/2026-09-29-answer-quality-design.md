# Answer quality — verbosity, formatting, and privileged-information emphasis

**Date:** 2026-09-29
**Status:** approved design
**Depends on:** Phases 1–4 (the answer layer and eval), Phase 5a (deployment, independent).

## 1. Goal

Answers in Teams are sometimes long-winded, visually flat, and spend space restating what the
asker could see themselves. This phase rewrites the prompt's style contract so answers are
scannable inside an Adaptive Card and lead with the information the asker likely *cannot* see —
without giving up any grounding accuracy, measured by the existing eval.

Owner decisions (2026-09-29):

- **Direct answers:** structured mini-answer — bold lead fact + citation, then short supporting
  bullets when they add something.
- **Summaries:** fixed sections — bold title, then Status / Causa / Último evento / Menos visível.
- **Privileged info:** surfaced when relevant to the question (preferred as a source), never as a
  forced section on unrelated answers.

## 2. What changes — `SYSTEM_PROMPT` (`src/claude/prompt.ts`)

The grounding rules keep their current semantics (never invent, cite bundle labels verbatim,
mirrored comments are not independent confirmation, disclose truncation, distinguish said vs
recorded, public vs internal). The "Formato" section is replaced by the full style contract:

### 2.1 Direct answers

- First line answers the question: the key fact in `**bold**`, citation inline.
- Up to 3 short supporting bullets, only when each adds something the lead line does not.
  A single-fact answer is the lead line alone — no bullets, no padding.
- Target ≤ 6 rendered lines. Longer only when the user asks for detail ("detalha", "explica
  melhor", "me conta tudo") or the question genuinely enumerates (e.g. "quais foram os casos de
  teste?").

### 2.2 Summaries (bare reference, `atualizar`, unfurl path)

Fixed skeleton, sections omitted when the bundle lacks them — never padded:

```
**<problema em uma linha> (QZ-252 ↔ chamado 16467)**
• Status: <estado + data relevante> [citação]
• Causa: <root cause condensada> [citação]           (quando conhecida)
• Último evento: <fato mais recente> [citação]
• Menos visível: <informação interna/cross-system> [citação]   (quando existir)
```

"Menos visível" = information the asker likely cannot see where they work: Zendesk internal agent
notes (DM surface only — the bundle already omits them on multiparty), Jira-only fields
(Root cause, Classificação QA, Origem do Defeito, tempo gasto), and cross-system facts (e.g. the
customer was/wasn't told).

### 2.3 Source preference

When an internal note or Jira-only field supports the answer as well as a public comment does,
cite the less-visible source and mark it ("nota interna", "campo do Jira"). Surfacing what the
asker can't see is the bot's unique value; restating what they can see is noise.

### 2.4 Rendering constraints (stated to the model)

Answers render inside an Adaptive Card TextBlock: `**bold**`, bullets, and links only. No
headers, no tables, no code fences. Quotes from the card keep their original language (existing
rule).

### 2.5 Collection-time de-duplication (behavior change)

The current rule "sempre informe o horário de coleta" duplicates the card footer, which already
renders "coletado às HH:MM" on every answer. The in-answer requirement is **dropped**; the footer
remains the single carrier. Eval cases asserting in-text collection time are updated to reflect
the moved display — a spec'd behavior change, not a weakened assertion. The model may still
mention collection time when the question is explicitly about data freshness.

## 3. What changes — eval (`test/grounding/`)

- New deterministic rule helpers in `rules.ts`: `maxLines(n)`, `mustLeadWithBold()` (first
  non-empty line starts with `**`), and reuse of `mustNotMatch` for headers (`/^#/m`) and code
  fences (/```/). Helpers get offline unit tests in `rules.test.ts`.
- Style assertions added to existing cases where the expectation is unambiguous; 2–3 new cases:
  a trivial single-fact question that must stay ≤ 2 lines with no bullets; a summary that must
  follow the skeleton (bold lead, expected section labels); a question where an internal note is
  the best source and must be cited.
- `npm test` stays fully offline; the live eval keeps its current corpus + the new rules.
- Guardrails that must not move: `mustCite`'s bracketed form; the renderer's date format
  (`harvestBundleDates` unchanged); no `SYSTEM_PROMPT` citation restyling.

## 4. What does NOT change

`src/bundle/render.ts` (bundle text and labels), `src/teams/cards.ts` (footer, buttons),
citation display styling, the model/config (`claude-sonnet-5`, adaptive thinking effort low,
two 1h cache breakpoints), date formatting, and the binding model.

## 5. Process and acceptance

1. **Baseline:** one live eval run before any prompt edit (≈ US$0.09, owner-confirmed), recording
   per-case grounding results.
2. Prompt iteration offline (unit tests + rendered-prompt inspection), then a live eval run
   (owner-confirmed) — repeat as needed.
3. **Acceptance:** final eval ≥ baseline on every grounding rule (no correctness regression);
   all new style rules pass; then a live Playground session (owner-confirmed) verifying the
   Adaptive Card actually renders bold/bullets correctly in DM and channel, summary and direct
   answers both.
4. If a style rule and a grounding rule conflict on some case, grounding wins and the style rule
   is adjusted — never the reverse.

## 5a. Addendum — Playground verification findings (2026-09-29, owner-reviewed screenshots)

The Adaptive Card renders bold/bullets correctly. Four styling corrections, owner-decided:

1. **The summary title no longer repeats the pair reference.** The Teams card header already
   shows `QZ-252 ↔ chamado 16467` with links; `(KEY ↔ chamado N)` in the body is redundant.
   The prompt drops it, and sty-02's `mustContain('AGL-900')` / `mustContain('20100')`
   assertions are removed with it (identification moved to the card header — a spec'd change;
   the CLI surface loses in-answer identification, an accepted trade-off since Teams is the
   primary surface).
2. **Summary section labels are bold** (`**Status:**`, `**Causa:**`, `**Último evento:**`) so
   labels outweigh their content visually.
3. **Citations are compressed at display time, in the Teams layer only** — per the standing
   rule that citation styling never happens in the prompt (the eval matches the model's exact
   bracketed output). A `compressCitations` transform applied where answers are rendered into
   cards: `[comentário jira 41713]` → `[jira 41713]`; `[comentário zendesk <id>]` →
   `[zendesk …<last 4>]` when the id exceeds 6 digits, else `[zendesk <id>]`;
   `[campo X]` → `[X]`. The model's raw output, the eval, and the CLI are untouched.
4. **"Menos visível" is replaced by a dynamic label naming the source kind** — the section's
   bold label depends on the information shown: `**Nota interna:**`, `**Só no Jira:**`, or
   `**Interno:**` as the generic. `prompt.test.ts`'s 'Menos visível' assertion follows the
   contract.

## 6. Risks

- **Style pressure can erode grounding** — that's what the baseline/final comparison exists to
  catch; acceptance is gated on no regression.
- **Adaptive Card markdown rendering** differs subtly between the Playground and real Teams
  (both use the same engine per Phase 3 spec §2, but bullets inside TextBlock need `\r` or `\n\n`
  separators in some clients — verified during the Playground session; if bullets don't render,
  the fallback is hyphen lines, a prompt-only change).
- **Eval case updates for §2.5** must be reviewed one by one so a legitimate assertion isn't
  dropped alongside the moved collection-time expectation.

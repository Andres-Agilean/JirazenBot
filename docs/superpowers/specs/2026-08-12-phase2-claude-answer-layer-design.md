# Phase 2 Design — Claude Answer Layer + Grounding Eval Set

> **Status:** approved 2026-08-12.
> Scope: plan §7 (Claude layer) and §12 Phase 2, as amended by
> `2026-08-10-teams-jira-zendesk-bot-design.md`. Where this document and the build plan
> conflict, this document wins. Phase 1 (resolver, fetchers, bundle, CLI) is complete and
> merged; this phase adds the `answer()` primitive and the eval set that guards it.

---

## 1. Corrections to the build plan

Verified against current Claude API documentation on 2026-08-12. Three of the plan's §7
assumptions no longer hold.

| Plan assumption | Reality | Consequence |
|---|---|---|
| Model behaves with no thinking | **`claude-sonnet-5` runs adaptive thinking by default.** | Configure it explicitly (§3). Thinking bills as output tokens and delays first token. |
| §7.2 "verify `cache_control` syntax" | Confirmed: `{"type": "ephemeral"}`, max **4** breakpoints, render order `tools → system → messages`, verify via `usage.cache_read_input_tokens`. | Design in §4 stands as planned. |
| §7.1 pricing | Confirmed: `claude-sonnet-5`, **$2/$10 per MTok intro through 2026-08-31**, then $3/$15. 1M context. | No change. |
| — (not in plan) | Sonnet 5 **rejects non-default `temperature`/`top_p`/`top_k`** (400). | Never send sampling params. |
| — (not in plan) | Sonnet 5 **does not support mid-conversation system messages** (Opus-tier only). | Operator context cannot be injected mid-conversation without invalidating the cached prefix. Relevant from Phase 3. |
| — (not in plan) | Sonnet 5 prompt-cache minimum is **1024 tokens**. | Live bundles measure ~2,700 tokens — comfortably cacheable. A very sparse card could fall below and silently not cache; not a correctness issue. |

Escalation target if grounding quality fails the eval set stays `claude-opus-5` per §7.1.

## 2. The primitive

```ts
answer(bundle: CardBundle, question: string, history: Turn[]): Promise<Answer>

type Turn   = { role: 'user' | 'assistant'; text: string };
type Answer = {
  text: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};
```

Per plan §3 there is exactly one path. The unfurl summary (Phase 4) is this function called
with a default question; every follow-up is the same function with the user's words. Do not
add a separate "summary" path.

### Module layout

```
src/claude/
  client.ts    # Anthropic client construction; injectable for offline tests
  prompt.ts    # system prompt (grounding rules) + bundle prefix assembly
  answer.ts    # the answer() primitive
scripts/ask.ts # npm run ask -- QZ-252 "há quanto tempo está bloqueado?"
test/grounding/
  cases.ts     # ~30 synthetic bundle + question + expectation triples
  rules.ts     # deterministic assertions
  judge.ts     # Claude-as-judge for refusal cases
  run.ts       # eval runner
```

## 3. Model configuration

| Setting | Value | Why |
|---|---|---|
| `model` | `claude-sonnet-5` (from config, not inline) | Plan §7.1 |
| `thinking` | `{ type: 'adaptive' }`, `display` left at default `omitted` | On but shallow; the model decides when duration/history questions need it |
| `output_config.effort` | `low` | Task is QA over supplied context, not hard reasoning |
| `max_tokens` | `2048` (`CLAUDE_MAX_TOKENS`) | Plan §11 |
| sampling params | **none** | Rejected by Sonnet 5 |
| tools | **none in Phase 2** | The four bounded tools are Phase 5 (plan §7.4) |

The thinking/effort pair is a starting point, not a conclusion. The eval runner accepts
overrides so the configuration can be swept and settled with evidence; record the winning
combination here when it is.

## 4. Prompt and cache structure

Stable content first, volatile last, so the cached prefix survives:

| Layer | Breakpoint | Contents |
|---|---|---|
| `system` | ✅ | Role, grounding rules (plan §7.3), pt-BR output rule, citation convention |
| `messages[0]` | ✅ | `<CARD_BUNDLE>…</CARD_BUNDLE>` including its `fetched_at` line |
| `messages[1..n]` | — | Conversation turns, newest question last |

Two of the four available breakpoints. **5-minute TTL** (plan §7.5) — on expiry, refetch the
bundle rather than extending the cache, because a warm cache answering "what's the current
status" is a correctness bug.

**The cache key already encodes the surface flag.** A `dm` bundle and a `multiparty` bundle
render to different bytes (addendum §3), so internal Zendesk notes cannot leak across
surfaces through a cache hit. No extra keying is required — but a future change that makes
the two surfaces render identically would silently break that guarantee.

**History** is capped at the **last 6 turns**, dropped oldest-first, and sits entirely after
the cached prefix. The CLI barely exercises this; it matters from Phase 3, where the binding
store owns conversation state.

## 5. Answer format and grounding

Answers are **plain pt-BR prose** that cite the bundle's own labels inline:

```
O incidente foi aprovado pelo QA em 11/08 [comentário jira 41713, André Marques].
Foram 26 casos de teste, todos aprovados. O chamado segue em "hold" no Zendesk
[campo Status], atualizado em 11/08.
```

The renderer already labels every element (`[comentário jira 41457]`, `[comentário zendesk
902]`, field labels), so citation is echoing a token that exists in the context — and a
deterministic rule can regex for it to prove a claim was sourced. No structured output: it
would flatten pt-BR prose and add schema-compile latency for a benefit Phase 4 does not yet
need.

Grounding rules in the system prompt come from plan §7.3 unchanged, with these additions
made concrete by Phase 1's renderer:

- Cite using the bracketed labels exactly as they appear in the bundle.
- When the bundle carries a `truncamento:` note, disclose the gap rather than answering as
  if the omitted content did not exist.
- A comment marked `[espelhado do Jira …]` is the same statement as its Jira original, not a
  second independent confirmation.
- Always state the bundle's `fetched_at` when answering about current status.

## 6. Testing — two separate things

The plan implies the eval set runs like a test suite. It cannot: applying a rule to an
answer requires *generating* that answer, which is a live API call. The split:

| Command | Network | Gates CI | What it covers |
|---|---|---|---|
| `npm test` | ❌ | ✅ | Prompt assembly, breakpoint placement, history truncation, usage parsing — against an injected fake client returning canned responses |
| `npm run eval` | ✅ | ❌ | 30 cases → Claude → deterministic rules → pass/fail table with token cost |
| `npm run eval -- --judge` | ✅ | ❌ | Adds the Claude judge for cases whose correct answer is a graceful refusal |

Run the eval set on every prompt change (plan §10). A full run costs roughly **$0.20–0.30**
at intro pricing, so it is cheap to run often.

### Judging strategy

Deterministic rules wherever a rule can express the expectation — must-contain a ticket id,
must-**not**-match an invented-date pattern, must cite a comment-id label. A Claude judge
handles only what rules cannot: whether a refusal was graceful and named what was missing,
versus hedged or invented.

### Eval corpus — synthetic, committed

Bundles are **hand-written synthetic** `CardBundle` objects, not captured customer data. Real
bundles carry customer names, emails, organizations and ticket contents, which is why
`test/fixtures/live/` is gitignored; an eval corpus must live in git to be useful to anyone
else on the team.

The known risk is that invented prose is cleaner than reality, so cases deliberately
reproduce the messiness observed in live captures: Automation-for-Jira workflow noise,
checkbox-form descriptions, collapsed mirrored comments, mixed pt-BR/en, ALL-CAPS titles,
sparse cards with mostly-null fields.

Cases are written as `CardBundle` objects fed through the real `renderBundle()`, never as
hand-written markdown — so the evals stay honest when the renderer changes.

### Case mix

Weighted toward refusal per plan §10.

| Category | ~n | Example |
|---|---|---|
| **Not in the bundle** | 10 | "Qual o prazo prometido ao cliente?" on a card with no due date — must say so, must not infer one from a comment |
| Fact retrieval | 6 | "Quem validou?" → must cite the comment id |
| History / duration | 5 | "Há quanto tempo está em teste?" → from the changelog, must not invent |
| Said-vs-recorded (§7.3) | 4 | A comment saying "entregamos sexta" with no `duedate` — must distinguish what a person said from what the system records |
| Public vs internal | 3 | Answer must respect which side a fact came from |
| Degraded bundles | 2 | Single-sided, and truncated-with-note — must disclose the gap |

## 7. Out of scope for Phase 2

No Teams integration, no binding store, no Adaptive Cards, no link unfurling (Phases 3–4).
No tools — the four bounded tools stay Phase 5 (plan §7.4). No streaming; the CLI prints the
finished answer. No write operations, ever (plan §2).

## 8. Acceptance

Per plan §12 Phase 2:

1. `npm run ask -- QZ-252 "há quanto tempo está bloqueado?"` returns a grounded pt-BR answer
   citing bundle labels.
2. The eval set passes, **especially the not-in-bundle cases**.
3. Cache reads confirmed in `usage.cache_read_input_tokens` on a repeat question against the
   same bundle within the TTL.
4. `npm test` stays offline and green.

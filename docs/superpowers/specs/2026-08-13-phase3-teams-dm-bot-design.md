# Phase 3 Design — Teams DM Bot

> **Status:** approved 2026-08-13.
> Scope: plan §9 and §12 Phase 3, as amended by `2026-08-10-teams-jira-zendesk-bot-design.md`
> (especially §8: MVP is DM-only, card interactions ship as temporary text commands) and
> `2026-08-12-phase2-claude-answer-layer-design.md` (especially §4: bundle lifetime). Where this
> document and the build plan conflict, this document wins. Phases 1 and 2 are complete and
> merged: a card reference resolves to a Jira↔Zendesk pair, both sides are fetched into a
> token-budgeted bundle, and `answer()` answers questions about it in grounded pt-BR.
>
> This phase puts that behind a Teams DM.

---

## 1. Verified SDK facts

The build plan (§5.1) warns that the Teams tooling landscape has been renamed twice and that
most tutorials — and most model training data — describe deprecated or wrong-target options.
Verified against live documentation on 2026-08-13:

| Fact | Value |
|---|---|
| Package | `@microsoft/teams.apps` (exports `App`); siblings under `@microsoft/teams.*` |
| Repository | `github.com/microsoft/teams-sdk` (formerly `teams.ts`) |
| Scaffold | `teams project new typescript <name> --template echo` (Teams Developer CLI, preview) |
| Handler | `app.on('message', async ({ send, activity }) => { … })` |
| Typing indicator | `await send({ type: 'typing' })` |
| Local auth | `new App({ skipAuth: true })` — local development only |
| Server | `app.start(process.env.PORT || 3978)` |
| Local test surface | M365 Agents Playground: `npm i -g @microsoft/m365agentsplayground`, then `agentsplayground -e http://localhost:3978/api/messages -c emulator`, UI at `localhost:56150` |

Do not scaffold with TeamsFx, as a "Custom Engine Agent", or with Teams AI Library v1 — all
three are the wrong target (plan §5.1).

## 2. Deployment target — local only, and why

The MVP runs **on a developer machine and is exercised through the M365 Agents Playground**.
No Azure Bot resource, no dev tunnel, no hosting, no Teams app sideloading.

This is not merely the convenient choice; it is the only unblocked one. A personal Azure
account can create an Azure Bot on the free F0 tier, but a bot registration is useless without
a Teams tenant to install into, and every free route to one is closed: a personal Microsoft
account's Teams cannot upload custom apps, and the **Microsoft 365 Developer Program sandbox
no longer accepts individual developers** — eligibility is automatic-only and limited to
Visual Studio Professional/Enterprise subscribers, ISV Success / AI Cloud Partner Program
members, and organizations with Premier or Unified Support. The remaining route is the
Agilean tenant, which requires approvals deliberately deferred.

The Playground runs the real activity protocol against the real handler with real card data.
What it does not exercise: sideloading, Teams identity, @mentions, and Adaptive Card
rendering. The first two are irrelevant to a plain-text DM MVP and the last two are Phase 4.

**Data-flow note.** The Playground is entirely local — `localhost:56150` talking to
`localhost:3978`; no conversation reaches Microsoft. It therefore introduces no new exposure.
The material data flow is one that already exists from Phase 2: every question sends the
rendered bundle — real customer names, emails, ticket bodies, internal agent notes — to the
Anthropic API. That should move to an organization account before this serves anyone beyond
the developer driving it.

## 3. Architecture — a thin adapter over a testable core

```
src/teams/
  app.ts            # Teams SDK App + activity wiring (thin; the only file importing the SDK)
  handleMessage.ts  # the whole pipeline, dependency-injected, returns replies as data
  bindings.ts       # BindingStore interface + InMemoryBindingStore
  commands.ts       # text-command parsing
  reply.ts          # answer + footer formatting
scripts/serve.ts    # npm run bot
```

`handleMessage(text, conversationKey, deps)` resolves to an array of replies; `app.ts` sends
them. The Teams SDK appears in exactly one file, so the entire pipeline is testable offline
with no SDK, no network, and no API key — the same seam that made Phase 2's `AnthropicLike`
work, applied to the Teams boundary.

`deps` carries the binding store, the bundle loader (`loadCardBundle`), the answer function,
and a clock. Every one is faked in tests.

**Conversation key.** In a DM the bot binds one active card per conversation (plan §9.3), keyed
on the activity's conversation id. Thread and group-chat keys are Phase 4.

## 4. State

```ts
interface Binding {
  ref: CardRef;              // what is bound
  bundle: CardBundle;        // assembled once and reused (Phase 2 spec §4)
  bundleFetchedAt: number;   // epoch ms
  history: Turn[];           // prior turns for answer(); capped at 6 by MAX_HISTORY_TURNS
  boundAt: number;
}

interface BindingStore {
  get(key: string): Promise<Binding | undefined>;
  set(key: string, binding: Binding): Promise<void>;
  delete(key: string): Promise<void>;
}
```

`InMemoryBindingStore` is the only implementation in this phase. The interface exists so Azure
Table Storage or Redis (plan §9.3) can replace it without touching the pipeline; restarts lose
bindings, which is acceptable for a demo-driven MVP and unacceptable later — that is the
trigger for implementing a persistent store, not a nice-to-have.

**Two clocks, deliberately separate:**

| Lifetime | Value | Meaning |
|---|---|---|
| Binding | 24h (plan §9.3) | How long the bot remembers *which card* you were discussing |
| Bundle | **15 minutes** | How long it reuses *the fetched data* before refetching Jira and Zendesk |

The build plan (§7.5) mandates a 5-minute TTL, having conflated bundle freshness with the
Claude prompt-cache TTL. They are separable: the prompt cache TTL is fixed by the API, but
reusing the fetched bundle beyond it costs only the cache discount, not correctness.
**Decided: 15 minutes.** Follow-ups within a working conversation stay fast and avoid hammering
the tenant's APIs, while every answer discloses its collection time and `atualizar` always
forces a refresh. A question arriving after expiry triggers a transparent refetch.

### 4.1 Prompt cache TTL — switch to 1 hour (amends Phase 2 spec §4)

Phase 2 used the default 5-minute `cache_control` TTL. With a 15-minute bundle lifetime that
leaves a dead zone: a follow-up between minute 5 and minute 15 reuses the same byte-identical
bundle but finds the cache gone, and pays a full-price rewrite. **Change the breakpoints to
`{ type: 'ephemeral', ttl: '1h' }`** so every follow-up inside the bundle's life is a cheap
read.

Reads stay at 0.1x base input either way; only the write moves, from 1.25x to 2x. On a
~2,700-token bundle:

| Event | 5-minute TTL | 1-hour TTL |
|---|---|---|
| First question (cache write) | US$0.0068 | US$0.0108 |
| Follow-up within 5 minutes | US$0.0005 | US$0.0005 |
| Follow-up at minute 8 | US$0.0068 (rewrite) | US$0.0005 |

A three-question conversation spread across ten minutes costs roughly US$0.014 at the 5-minute
TTL versus US$0.012 at one hour, and the gap widens with each additional question. At the
projected 20-100 cards/day this is approximately the difference between US$65 and US$50 per
month.

**The tradeoff is real and points the other way for one-shot questions:** a 2x write that is
never read back is worse than a 1.25x one. Multi-turn conversation is the premise of the DM
surface, so one hour is the right default here — but **Phase 4's unfurl summary is genuinely
one-shot** (a card is posted, often with no follow-up) and should reconsider the 5-minute TTL
for that path rather than inheriting this choice unexamined.

Add a test asserting the TTL value on both breakpoints, so a silent regression to the default
is caught offline.

## 5. Message pipeline

Branches are evaluated in this order. Each reuses Phase 1/2 code rather than adding a second
parser.

1. **Command** — `ajuda` or `atualizar` (§6).
2. **Reference + question** — `splitReferenceAndQuestion(text, allowedProjects)` returns both.
   Bind the card, answer the question.
3. **Reference alone** — the whole message parses as a reference. Bind, then answer
   `DEFAULT_SUMMARY_QUESTION` (Phase 2), which is the same `answer()` call, not a second path.
4. **No reference, binding exists** — answer against the bound bundle, refetching first if the
   bundle is older than 15 minutes.
5. **No reference, nothing bound** — the help text from §6.

**The bare-number guard comes free.** `parseReference` already returns `explicit: false` for a
whole-message bare number (plan §6.1). Rule: when a binding exists, a non-explicit reference is
**not** a rebind — it is treated as a question. So "vimos 12 casos desses" cannot silently
switch which card is being discussed. When no binding exists, a bare number binds as a Zendesk
ticket and the reply states that assumption.

A **typing indicator** is sent before every branch that calls Claude or the tenant APIs; those
take seconds and silence reads as a broken bot.

## 6. Commands and disambiguation

Commands are matched case-insensitively and accent-insensitively on the whole message.

| Command | Behavior |
|---|---|
| `ajuda` | Usage text: how to reference a card, the available commands, and the currently bound card if any |
| `atualizar` | Refetch the bound card and confirm with the new collection time. With nothing bound, says so. |

Per addendum §8 these are **temporary stand-ins for Adaptive Card affordances** and become
aliases when Phase 4 ships buttons.

**Disambiguation asks for the key, not a menu number.** When a reference resolves to several
counterparts, the bot lists the candidates and asks the user to reply with the key:

```
Esse chamado está vinculado a 2 cards do Jira — responda com a chave:
QZ-252 (App travando ao tirar foto)
AGL-1500 (Erro no relatório de avanço)
```

A numbered menu was considered and rejected. A reply of `1` collides with the bare-number rule
above and would be read as Zendesk ticket #1, so a menu would require the binding to carry a
pending-choice state and the pipeline to check it before branch 2 — a stateful branch and an
ordering rule that is easy to break later. Replying with `QZ-252` parses unambiguously as an
ordinary reference through branch 2, needing no new state at all. The case is also rare on this
tenant: the primary resolver reads a single "Zendesk ID" field per issue, so ambiguity arises
only when two Jira issues carry the same ticket number.

## 7. Reply format

Plain text (addendum §8). Every answer carries a footer naming the bound card and the
collection time, so the user never has to guess what the bot is discussing (plan §9.3):

```
— QZ-252 ↔ chamado 16467 · coletado às 14:32
```

Jira keys and ticket ids are rendered as markdown links to the source systems, using
`Config.siteUrl` for Jira and the Zendesk subdomain — Teams renders markdown links in plain
messages, so deep linking needs no card.

## 8. Error handling

Every failure produces a specific pt-BR message. The bot must never reply with a stack trace
and must never go silent — an unanswered DM reads as broken.

| Condition | Reply |
|---|---|
| Reference parses, card not found | Names what was searched for |
| Multi-match | The key list from §6 |
| Jira or Zendesk unreachable | Says which system failed and that the question can be retried |
| Claude rate-limited or erroring | Says the answer service is unavailable; suggests retrying |
| Answer truncated | Phase 2 already appends its pt-BR notice; pass it through unchanged |
| Unhandled exception | Generic pt-BR apology; full detail to the server log, never to the user |

## 9. Testing

`handleMessage` is tested offline against a fake answer function, a fake bundle loader, an
in-memory store, and an injected clock. Cases: binding on first reference; three follow-ups
without re-referencing; explicit card switch; a bare number mid-conversation **not** rebinding;
`atualizar` forcing a refetch; bundle TTL expiry triggering a refetch; disambiguation; help with
and without a binding; and every error row in §8.

`npm test` stays fully offline. The live exercise is a Playground session (§10).

## 10. Out of scope

@mentions, group chats, channels, Adaptive Cards, link unfurling, the Refresh/correction/
disambiguation **buttons** (all Phase 4). Azure Bot registration, hosting, dev tunnels,
sideloading, persistent storage, per-user OAuth. The four bounded tools (plan §7.4) and
rate-limit backoff, Key Vault, and structured logging (Phase 5).

## 11. Acceptance

In the M365 Agents Playground, against the live tenant:

1. `QZ-252` → grounded pt-BR summary with the footer.
2. Three follow-ups with no re-reference, each answered from the bound card.
3. `chamado 16467` → switches cards, footer updates.
4. A bare number mid-conversation does **not** rebind (plan §6.1).
5. `atualizar` → refetches, footer shows a new collection time.
6. `ajuda` → usage text naming the bound card.
7. A nonexistent key → the pt-BR not-found message, no stack trace.
8. `npm test` green and offline.

Per plan §10, run the grounding eval with `--judge` once at the start of implementation to
establish an honest baseline before the prompt is touched again — Phase 2 closed with a
rules-only 28/30, which is a deterministic floor rather than a grounding score.

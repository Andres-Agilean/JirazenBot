# Phase 4 Design — Multiparty Surface and Adaptive Cards

> **Status:** approved 2026-08-13.
> Scope: build plan §12 Phase 4 and §9, as amended by `2026-08-10-teams-jira-zendesk-bot-design.md`
> (§3 surface flag and internal-note suppression, §8 MVP scope) and
> `2026-08-13-phase3-teams-dm-bot-design.md` (§2 records that `serve.ts` hardcodes the surface;
> §4.1 records the cache-TTL question that rides with unfurl). Where this document and the build
> plan conflict, this document wins.
>
> Phases 1–3 are complete and merged: a reference resolves to a Jira↔Zendesk pair, both sides are
> fetched into a token-budgeted bundle, `answer()` answers questions about it in grounded pt-BR,
> and a Teams DM binds one card per conversation across follow-ups.
>
> This phase takes that into channels and group chats, and gives it buttons.

---

## 1. Scope split — why unfurling is not in this phase

The build plan bundles link unfurling with the multiparty surface and calls it "the last item."
It is now a separate phase, **4b**, for a reason discovered while planning this one:

**Link unfurling cannot be tested locally at all.** It is a message extension
(`composeExtensions` → `messageHandlers` of type `link`), declared in the Teams app manifest. The
M365 Agents Playground documentation states plainly that "bot or agent features enabled through
the Teams app manifest aren't available as Agents Playground doesn't process it," and lists
message extensions as **Not Available**. There is no local path to exercising it — it needs an
Azure Bot registration and a tenant that permits sideloading, which are IT-gated at Agilean and
deliberately deferred.

Everything else in Phase 4 — surface derivation, @mention handling, multiparty binding, Adaptive
Cards, the Refresh action — is fully exercisable in the Playground, which supports personal,
group chat, and team/channel scopes and renders Adaptive Cards with the same engine as Teams
(Phase 3 spec §2).

**Phase 4 therefore ships everything that can be verified, and 4b ships unfurl when tenant access
exists.** Writing unfurl now would mean committing unverifiable code whose first real execution is
in front of users. The cache-TTL reconsideration from Phase 3 spec §4.1 belongs to 4b with it,
since the one-shot access pattern is the thing that motivates it.

## 2. Surface derivation — fail closed

`scripts/serve.ts` currently passes the constant `SURFACE = 'dm'` for every conversation. A group
chat answered today would include internal Zendesk agent notes — exactly what addendum §3's
`multiparty` surface exists to suppress. **This is the first change of the phase and nothing else
should land before it.**

```ts
// src/teams/surface.ts
export function surfaceFor(conversationType: string | undefined): Surface {
  return conversationType === PERSONAL_CONVERSATION_TYPE ? 'dm' : 'multiparty';
}
```

Only the exact string `'personal'` yields `dm`. Everything else — `groupChat`, `channel`,
`undefined`, a value Microsoft adds next year — yields `multiparty` and omits internal notes.

This is not merely the cautious choice. The SDK types the field as
`'personal' | 'groupChat' | Omit<string, 'personal' | 'groupChat'>` — an **open** union that
admits values not in the list. A mapping table over known types would have an unreachable-looking
default that is in fact reachable, and the cost of being wrong is asymmetric: fail closed and a DM
loses internal notes it was entitled to, which is visible and annoying; fail open and internal
agent notes reach a channel, which is silent and not undoable.

The Phase 3 tripwire in `test/surface.test.ts` flips from asserting the constant is `'dm'` to
asserting the mapping, including that an unrecognised string yields `multiparty`.

**Surface is part of the cache key.** Addendum §3 already requires this, and it now matters in
practice: the same card viewed from a DM and from a channel renders different bytes, so the
prompt-cache prefix and any bundle cache must both key on the surface. A change that made the two
surfaces render identically would silently break the guarantee.

## 3. A plain-data boundary

`handleMessage` must keep working with no SDK, no network, and no API key — the seam that made
Phase 3 testable. So `app.ts` converts an activity into primitives before calling in:

```ts
export interface Incoming {
  text: string;             // mentions already stripped
  conversationId: string;
  conversationType: string | undefined;
  userId: string;
}
```

`handleMessage(incoming, deps)` replaces `handleMessage(text, key, deps)`.

**Mention stripping is a pure function.** In a channel Teams delivers `<at>Agilean Bot</at>
QZ-252`, and an unstripped mention puts the bot's display name inside the text the parser sees —
enough to break reference parsing outright. `stripMentions(text, mentions)` takes the text and a
minimal `{ text: string }[]` shape rather than an SDK entity type, so it is tested offline like
everything else.

**@mentions are mandatory in channels and group chats.** Teams only delivers messages that mention
the bot. This is a platform constraint, not a design choice, and it shapes acceptance: a follow-up
in a channel still requires an @mention, it just does not require re-stating the card.

## 4. Two-level binding — shared thread, personal split

A channel thread has several people in it. One binding for the thread is right most of the time —
the card *is* the thread's subject — but it must be possible for one person to ask about something
else without dragging everyone with them.

```ts
interface BindingStore {
  getShared(conversationId): Promise<Binding | undefined>;
  setShared(conversationId, binding): Promise<void>;
  getPersonal(conversationId, userId): Promise<Binding | undefined>;
  setPersonal(conversationId, userId, binding): Promise<void>;
  clearPersonal(conversationId, userId): Promise<void>;
}
```

Resolution for a message with no reference is **personal first, then shared**.

The split is carried by a distinction the Phase 3 pipeline already draws — bare reference versus
reference-with-question — which until now did the same thing in both cases:

| Message | Meaning | Effect |
|---|---|---|
| `QZ-252` (bare) | "let's talk about this card" — addressed to the room | `setShared` **and** `clearPersonal` |
| `QZ-252 quem validou?` | "quick question about my own thing" | `setPersonal` only; the thread's card is untouched |
| `quem validou?` (no ref) | a follow-up | answered against `personal ?? shared` |
| `voltar` | rejoin the thread | `clearPersonal` |

Worked example:

```
Ana:   QZ-252                      → thread bound to QZ-252
Bruno: AGL-900 qual o status?      → Bruno splits off; Ana's card untouched
Bruno: e o prazo?                  → answered on AGL-900
Ana:   quem validou?               → answered on QZ-252
Bruno: voltar                      → Bruno back on QZ-252
```

**This collapses to exactly Phase 3 in a DM.** One user, so a bare reference sets shared and
clears personal, and a reference-with-question sets a personal binding that the same user resolves
first — behaviourally identical to today. The existing DM tests must pass **unmodified**; that is
the regression proof, and a change to any of them is a signal the collapse is wrong, not a test to
update.

Both layers keep the Phase 3 lifetimes: binding 24h, bundle 15 minutes, refreshed transparently on
expiry. `voltar` with no personal binding says so in pt-BR rather than failing silently.

## 5. Adaptive Cards

Every answer becomes a card. Layout, chosen against alternatives because a channel reader skims
and needs to know *which card and what state* before reading prose:

```
┌──────────────────────────────────────┐
│ **QZ-252** ↔ chamado 16467           │
│ Em Teste · coletado às 14:32         │
│ ──────────────────────────────────── │
│ O incidente foi aprovado pelo QA em  │
│ 11/08 [comentário jira 41713, André  │
│ Marques]. Foram 26 casos de teste,   │
│ todos aprovados.                     │
│                                      │
│ [ Atualizar ] [ Jira ] [ Zendesk ]   │
└──────────────────────────────────────┘
```

`buildAnswerCard(answerText, binding, cfg, opts)` returns **plain card JSON**, so its tests assert
structure with no SDK and no network. `@microsoft/teams.cards` is already installed (it arrived
with `teams.apps`), so this adds no dependency.

- Header: Jira key and Zendesk ticket, each a deep link, omitting whichever side the card lacks —
  the same single-sided handling `formatFooter` already has, and reusing that logic rather than
  restating it.
- Status line: the Jira status when present, else the Zendesk status, then the collection time in
  `America/Sao_Paulo`.
- Answer: one `TextBlock` with `wrap: true`. Adaptive Card markdown covers bold, italics, lists and
  links — enough for our prose and its bracketed citations. It does not support tables; our answers
  do not use them.
- A personal-binding answer marks the header (`· sua consulta`) so a reader can see it is off the
  thread's card.

Text commands keep working as aliases, as Phase 3 §6 promised.

## 6. Refresh

The Refresh button is an invoke that calls **the same function** `atualizar` calls. One code path,
so the button and the command cannot drift apart. An invoke arriving for a conversation with no
binding replies in pt-BR rather than erroring.

## 7. Error handling

Phase 3 §8's table stands unchanged. Two additions:

| Condition | Reply |
|---|---|
| Card construction throws | Fall back to the Phase 3 plain-text reply. `withFooter` stays for this reason — it is a fallback, not dead code. |
| Unrecognised invoke action | pt-BR message naming what the bot understood; never an unhandled rejection. |

The Phase 3 rules still bind: never a stack trace, never an English error, never an empty reply.

## 8. Testing

Everything in this phase is offline-testable, and `npm test` stays offline.

New cases: the surface mapping including unknown and `undefined` types; mention stripping across
single, multiple and no mentions; the shared/personal resolution order; the split-and-rejoin
sequence from §4 end to end; `voltar` with and without a personal binding; card structure for
two-sided, Jira-only and Zendesk-only bundles; the personal marker; and the card-failure text
fallback.

The Phase 3 DM suite runs unmodified as the regression proof described in §4.

## 9. Out of scope

**Phase 4b:** link unfurling, its manifest, and the cache-TTL reconsideration for the one-shot
path (Phase 3 spec §4.1).

**Phase 5:** rate-limit backoff, Key Vault, structured logging with token accounting, the
disambiguation card, the four bounded tools (plan §7.4).

**Still deferred:** Azure Bot registration, hosting, dev tunnels, sideloading, persistent storage,
per-user OAuth. Auth stays off (`dangerouslyAllowUnauthenticatedRequests`) for local use; do not
expose the port through a tunnel in that mode.

## 10. Acceptance

In the M365 Agents Playground, launched with `--channel-id msteams` so Teams-specific activities
are available:

1. **Surface, in a group chat or channel:** a card with internal Zendesk notes answers **without**
   them, and says so — the addendum §3 disclosure. The same card in a DM includes them.
2. **@mention:** `@bot QZ-252` in a channel binds and answers; the bot's name does not leak into
   the parsed reference.
3. **Follow-up:** `@bot quem validou?` answers against the bound card without re-referencing it.
4. **Split:** a second user sends `@bot AGL-900 qual o status?`; the first user's next follow-up
   still answers about the original card.
5. **Rejoin:** `voltar` returns the second user to the thread's card.
6. **Card:** the answer renders with header, status, collection time and three actions; deep links
   open the right systems.
7. **Refresh:** the button produces the same result as typing `atualizar`, with a new collection
   time.
8. **DM regression:** the Phase 3 acceptance script still passes unchanged.
9. `npm test` green and offline, with the Phase 3 DM tests unmodified.

Not verifiable locally: link unfurling (§1, Phase 4b) and the typing indicator (Phase 3 spec §2).

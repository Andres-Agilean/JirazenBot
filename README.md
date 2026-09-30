# TeamsBot

A Microsoft Teams bot that answers free-form questions, in Brazilian Portuguese, about **one work
item at a time** — a Jira issue and/or the Zendesk ticket linked to it.

Someone on the support team references a card, the bot resolves the Jira↔Zendesk pair, assembles
everything known about it into one context bundle, and answers questions against that bundle using
the Claude API. It stays on that card across follow-ups, so you can just keep asking.

```
você:  QZ-252
bot:   [card] O incidente foi aprovado pelo QA em 11/08 [comentário jira 41713, André Marques].
              Foram 26 casos de teste, todos aprovados.
              QZ-252 ↔ chamado 16467 · Em Teste · coletado às 14:32   [Atualizar][Jira][Zendesk]

você:  e o cliente foi avisado?
bot:   [card] A última resposta pública no Zendesk é anterior à correção; tudo depois disso são
              notas internas espelhadas do Jira. Não há registro de aviso ao cliente.
```

## What it does

- **Resolves a reference to a card.** `QZ-252`, `chamado 16467`, `tickets 16467`, `#16467`, a bare
  ticket number, or a Jira/Zendesk URL. Finds the counterpart on the other system.
- **Assembles a bundle.** Whitelisted Jira fields, status history, comments (newest first),
  attachments, plus the Zendesk ticket and its comments — condensed to fit a token budget, with any
  omission disclosed in the bundle rather than hidden.
- **Answers, grounded.** Every claim cites the bundle's own labels (`[comentário jira 41713]`,
  `[campo Status]`). When the answer is not in the bundle, it says so instead of inferring.
- **Holds the card.** One binding per conversation, reused across follow-ups. In a channel the
  thread shares a card, and any participant can split off with their own without moving everyone.

## Read-only, always

The bot performs **no writes of any kind** against Jira or Zendesk — no comments, no transitions,
no edits. Every client method is a GET. This is a hard project rule, verified in review.

## Surfaces and internal notes

The bundle is assembled differently depending on where the question was asked:

| Surface | Zendesk internal agent notes |
|---|---|
| 1:1 chat (`personal`) | included |
| group chat, channel, anything else | **omitted**, and the gap disclosed to the model |

The surface is derived from the conversation and **fails closed**: only an exact `personal`
conversation type yields the DM surface. Any unrecognised or missing value is treated as
multiparty, because leaking agent-only notes into a channel is silent and not undoable.

## Getting started

Requires Node 20+.

```bash
npm install
cp .env.example .env    # then fill in the blanks — see below
npm test                # 365 tests, fully offline, no API key needed
```

`.env.example` ships with placeholder tenant values. Fill in your own:

| Variable | What it is |
|---|---|
| `ATLASSIAN_SITE_URL` | Your Jira site, used for the links humans click |
| `ATLASSIAN_CLOUD_ID` | Your Jira cloud id — a **scoped** Atlassian token only works against the `api.atlassian.com/ex/jira/{id}` gateway, never the site URL directly |
| `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` | Atlassian credentials |
| `ATLASSIAN_ALLOWED_PROJECTS` | Project keys the bot will resolve |
| `ZENDESK_SUBDOMAIN` / `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` | Zendesk credentials |
| `JIRA_ZENDESK_ID_FIELD` | The Jira custom field holding the Zendesk ticket number |
| `ANTHROPIC_API_KEY` | Claude API key |
| `BOT_CLIENT_ID` / `BOT_CLIENT_SECRET` / `BOT_TENANT_ID` | Azure Bot credentials — hosted deployments only; see [Deploying to real Teams](#deploying-to-real-teams) |
| `ALLOW_UNAUTHENTICATED` | `true` only for local Playground runs — never on a host |

## Running it in the M365 Agents Playground

The bot runs on a developer machine and is exercised through the
[M365 Agents Playground](https://www.npmjs.com/package/@microsoft/m365agentsplayground), which
speaks the real Teams activity protocol entirely on `localhost` — no Azure Bot resource, no
tenant, no dev tunnel, and no conversation ever reaches Microsoft. It needs a filled-in `.env`:
starting the bot and talking to it makes **live** calls to Jira, Zendesk and the Anthropic API.

Two terminals:

```bash
# terminal 1 — the bot, listening on http://localhost:3978/api/messages
npm run bot

# terminal 2 — the Playground, pointed at that endpoint
npx @microsoft/m365agentsplayground -e http://localhost:3978/api/messages --channel-id msteams
```

The Playground UI opens at `http://localhost:56150`. Type a card reference (`QZ-252`,
`chamado 16467`, a Jira URL…) and go from there — see [Talking to it](#talking-to-it).

Details that matter:

- **`--channel-id msteams` is required.** Without it the Playground uses the `emulator` channel,
  which omits the Teams-specific mock activities (channel and team conversation updates) that the
  multiparty surface needs.
- **Group chats and channels are simulated in the UI.** The Playground ships mock `personalChat`,
  `groupChat` and `team`/channel scopes plus five customizable mock users. Use them to verify the
  surface rule: internal Zendesk notes appear in a 1:1 chat and are omitted everywhere else.
- **A different port works** — `scripts/serve.ts` honours `PORT`; keep the `-e` endpoint in sync.
- **The typing indicator will not appear.** The Playground does not render it. The bot sends one
  on every Claude call and it shows up in real Teams; its absence locally is not a defect.
- **Link unfurling cannot be exercised here.** It is declared in the Teams app manifest, which
  the Playground does not process — see [Status](#status).

Local runs set `ALLOW_UNAUTHENTICATED=true` in `.env` (the default in `.env.example`), which is
what allows the bot to start without Bot Framework credentials. **Do not expose the port through
a tunnel in that mode.** Hosted deployments use real credentials instead — see
[Deploying to real Teams](#deploying-to-real-teams).

## Deploying to real Teams

The Playground needs none of this; a real Teams installation needs all of it: a single-tenant
Entra app registration, an Azure Bot resource with the Teams channel, an App Service running
`npm start`, and the `appPackage/` manifest zip installed in the tenant. The full operator
walkthrough — CLI commands, env vars, smoke test, secret rotation — is in
[docs/deploy-azure.md](docs/deploy-azure.md).

Hosted deployments set `BOT_CLIENT_ID`/`BOT_CLIENT_SECRET`/`BOT_TENANT_ID` and never set
`ALLOW_UNAUTHENTICATED`; the bot refuses to start half-configured rather than accept
unauthenticated traffic.

## Talking to it

| Message | Effect |
|---|---|
| `QZ-252` | Binds that card for the conversation and summarises it |
| `QZ-252 quem validou?` | Answers that question; in a thread, binds it to **you** only |
| any question | Answered against the currently bound card |
| `atualizar` | Refetches the card (the **Atualizar** button does the same) |
| `buscar <nome>` | Procura atividades abertas por empresa, cliente ou obra |
| `voltar` | Rejoins the thread's card after you split off |
| `ajuda` | Usage text |

Vague questions like "qual o status da empresa X?" work without a bound card — the bot searches
and shows the matching atividades abertas.

After a search or rundown you can ask follow-ups about that portfolio: `quantos?` answers with
exact counts (optionally filtered by status, e.g. `quantos bloqueados?`); `todos os de jira` /
`todos os de zendesk` / `mostra tudo` re-render the rundown uncapped; free-form questions like
"quem é responsável pela maioria?" are answered grounded in that portfolio's data. Asking about
another company switches context; follow-ups stay on the current one.

You can send the card's assignee a Teams reminder with `lembrar responsável` (optionally
followed by a colon and note). The bot looks them up in the organization directory by name,
asks you to pick when several match, and always shows a confirmation before anything is sent —
delivery needs the Azure deployment; in the local Playground the command answers that sending
is unavailable.

In a channel every message must @mention the bot — that is a Teams constraint, not a choice. A
bare number mid-conversation is treated as a question, never as a card switch, so "vimos 12 casos
desses" cannot silently move you to ticket 12.

Bindings last 24 hours; the fetched data is reused for 15 minutes and refetched transparently
after that. Every answer states when its data was collected.

## Other commands

```bash
npm run card -- QZ-252              # print the assembled bundle
npm run ask -- QZ-252 "pergunta"    # one-shot answer from the CLI
npm run fixtures -- 16560 AGL-1658  # capture live payloads as test fixtures (gitignored)
npm run eval                        # grounding eval — LIVE, costs ~US$0.09 per run
```

`npm test` never touches the network. `npm run eval` and `npm run ask` do.

## Layout

```
src/resolve/   reference parsing and Jira↔Zendesk resolution
src/fetch/     GET-only Jira and Zendesk clients, ADF/wiki → markdown
src/bundle/    bundle assembly, token budgeting, rendering
src/claude/    the answer() primitive, prompt and cache structure
src/teams/     Teams adapter, binding store, commands, cards
test/grounding/  synthetic eval corpus and rules
docs/superpowers/specs/   design decisions, phase by phase
```

The Teams SDK is imported in exactly one file (`src/teams/app.ts`), which is what lets the whole
message pipeline be tested offline with no SDK, no network and no API key.

## Status

Phases 1–4 are complete: resolution, fetching and bundling; the grounded answer layer and its eval;
the Teams DM surface; and the multiparty surface with Adaptive Cards.

Not yet built: link unfurling, a manifest-driven message extension the Playground cannot exercise.
The Azure Bot registration it needs is now covered by
[docs/deploy-azure.md](docs/deploy-azure.md). Also still open: Phase 5 hardening (rate-limit
backoff, Key Vault, structured logging with token accounting, and the bounded tools).

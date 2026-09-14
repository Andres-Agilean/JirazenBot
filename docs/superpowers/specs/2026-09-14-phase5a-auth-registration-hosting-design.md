# Phase 5a — Authentication, Azure Bot registration, and App Service hosting

**Date:** 2026-09-14
**Status:** approved design
**Depends on:** Phases 1–4 (complete). Unblocks Phase 4b (link unfurling), which needs the
registration this phase creates.

## 1. Goal and scope

Take the bot from "Playground on a developer machine" to "installed in the Agilean Teams tenant":

1. Real request authentication in the code (JWT validation of inbound Bot Framework calls,
   authenticated outbound replies).
2. A Teams app manifest package so the bot can be installed.
3. Azure App Service deployment artifacts and a step-by-step operator guide covering the Entra
   registration, the Azure Bot resource, hosting, and installation.

**Deliberately out of scope** (owner decision, 2026-09-14 — keep the phase minimal):

- **Persistent bindings.** `InMemoryBindingStore` stays: a deploy or restart forgets which card a
  conversation was on and users re-reference it. Acceptable for a pilot; revisit in Phase 5.
- **Link unfurling (4b).** Becomes *possible* after this phase but remains its own phase.
- **Key Vault, backoff, structured logging** — the rest of Phase 5.
- Moving Anthropic/Jira/Zendesk credentials to org-managed service accounts remains an owner
  decision, unchanged by this phase.

A follow-up phase is already queued after this one: a prompt-tuning pass on answer verbosity,
formatting, and emphasis on permission-gated information. It is not part of this design.

## 2. Bot identity — single-tenant + client secret

Chosen at registration time and mirrored in the code:

- **Single-tenant** Entra app registration: only tokens from the Agilean tenant are accepted.
  The bot is internal-only; multi-tenant is a wider surface for no benefit.
- **Client secret** credentials. The SDK (`@microsoft/teams.apps` 2.0.15) takes
  `clientId`/`clientSecret`/`tenantId` directly in the `App` options and activates its
  JWT-validation middleware when credentials are present (verified against the installed
  package's `app.d.ts` and `middleware/jwt-validation-middleware.d.ts`). A user-assigned managed
  identity would avoid the secret but needs a custom token callback and complicates local runs;
  rejected for now. Secrets expire (max 24 months) — the deploy guide must say where to renew and
  what the failure looks like when one lapses.
- Secrets live in App Service configuration for this phase. Key Vault is Phase 5 proper.

## 3. Authentication in the code — fail closed

New env vars, all optional in the schema, resolved by a **pure, fail-closed decision function**:

| `BOT_CLIENT_ID`+`BOT_CLIENT_SECRET`+`BOT_TENANT_ID` | `ALLOW_UNAUTHENTICATED` | Result |
|---|---|---|
| all three set | (ignored) | authenticated mode: credentials passed to `App` |
| none set | `true` | unauthenticated mode (Playground) |
| none set | unset/`false` | **refuse to start**, pt-BR error |
| partially set | anything | **refuse to start**, pt-BR error naming the missing var(s) |

Reasoning, same shape as the surface rule (CLAUDE.md hard rule 5): the costs are asymmetric. Fail
closed and a misconfigured deploy won't boot (visible, annoying); fail open and a production
endpoint accepts forged activities that can claim `conversationType: 'personal'` and read internal
Zendesk notes (silent, not undoable). The explicit `ALLOW_UNAUTHENTICATED` flag exists so that
"credentials absent" alone can never mean "open the endpoint" — local mode is a stated choice,
`true` only in `.env.example` and the Playground docs.

Mechanics:

- `src/teams/authMode.ts`: `resolveAuthMode(cfg)` returns a discriminated union
  (`{ mode: 'authenticated', clientId, clientSecret, tenantId } | { mode: 'unauthenticated' }`)
  or throws with the pt-BR message. **No SDK import** — fully offline-testable.
- `src/teams/app.ts` (the one SDK file) maps that union onto the `App` constructor options:
  credentials in authenticated mode, `dangerouslyAllowUnauthenticatedRequests: true` only in
  unauthenticated mode. The flag never appears alongside credentials.
- `src/config.ts`: schema gains `BOT_CLIENT_ID`, `BOT_CLIENT_SECRET`, `BOT_TENANT_ID` (optional
  strings) and `ALLOW_UNAUTHENTICATED` (default `false`); `Config` carries them through.
- `.env.example`: the four vars, commented, `ALLOW_UNAUTHENTICATED=true` as the local default with
  a warning that it must never be set on a host.
- The startup error is human-facing operator text and therefore Brazilian Portuguese (hard rule 2
  applies to operators too — they are the humans reading it).

## 4. Teams app manifest — `appPackage/`

- `appPackage/manifest.json`, current stable schema version. Bot entry with scopes `personal`,
  `groupChat`, `team`; `supportsFiles: false`; `isNotificationOnly: false`. Command list surfaces
  `ajuda` and `atualizar` with pt-BR descriptions. Name/description in pt-BR.
- The bot id appears as a documented placeholder the operator replaces with the registration's
  client id before zipping (no tooling that rewrites it — one id, one manual edit, documented).
- `appPackage/color.png` (192×192) and `appPackage/outline.png` (32×32): generated placeholder
  icons, explicitly marked replaceable with a real logo.
- **No `composeExtensions`** — unfurling is Phase 4b and gets a manifest *update*, not a rewrite.
- The guide covers zipping the three files and installing via Teams admin center (org catalog) or
  sideload for the pilot.

## 5. Hosting — Azure App Service

- `package.json` gains `"start": "tsx scripts/serve.ts"` — the no-build-step rule holds in
  production; tsx resolves at runtime exactly as it does locally.
- **`tsx` moves from `devDependencies` to `dependencies`.** A production install
  (`npm install --omit=dev`, which App Service's build performs) would otherwise drop the very
  binary `start` invokes. It is a runtime loader for this project, not a dev tool.
- `scripts/serve.ts` already honors `PORT`, which App Service sets. No code change.
- Node 22 LTS runtime on Linux App Service (Node 20+ is the project floor).
- Deployment is zip deploy / `az webapp up`; all env vars (tenant credentials, Anthropic key, bot
  credentials) set in App Service configuration. No Dockerfile, no CI pipeline this phase.
- The messaging endpoint is `https://<app>.azurewebsites.net/api/messages`.

## 6. Operator guide — `docs/deploy-azure.md`

Step-by-step, in order, with the exact portal/CLI actions:

1. Entra app registration (single-tenant) → note client id + tenant id → create client secret.
2. Azure Bot resource (F0) using that app id; set the messaging endpoint; enable the Teams
   channel.
3. App Service (Linux, Node 22): create, set env vars, deploy, verify startup logs show
   authenticated mode.
4. Fill the bot id into `manifest.json`, zip `appPackage/`, install via admin center or sideload.
5. Smoke test in real Teams (DM + channel), including the typing indicator finally being visible.
6. Operational notes: secret expiry/rotation, where logs live, what a 401 from Microsoft looks
   like vs. a wrong endpoint.

README gets a short "Deploying to real Teams" section linking to the guide, next to the
Playground section.

## 7. Testing and acceptance

- **TDD on `resolveAuthMode`:** full credentials → authenticated; no credentials + flag →
  unauthenticated; no credentials, no flag → throws; each partial-credential combination → throws
  naming the missing variable; flag set *alongside* full credentials → authenticated (credentials
  win; the flag is ignored, never combined).
- Config tests for the new schema fields and defaults.
- `npm test` stays fully offline (hard rule 7): auth mode is pure logic; no tokens are fetched in
  tests.
- Acceptance, in order:
  1. `npm test` green offline.
  2. Playground run with `ALLOW_UNAUTHENTICATED=true` behaves exactly as today.
  3. Startup with no bot credentials and no flag exits with the pt-BR configuration error.
  4. Deployed to App Service with real credentials: the bot answers in a real Teams DM (internal
     notes included) and in a channel via @mention (internal notes omitted) — the Phase 4 surface
     rule verified for the first time against real Teams.

## 8. Risks and open items

- The SDK's single-tenant token validation path is verified from type declarations, not yet
  exercised; the deployed smoke test is the real proof. If the SDK misbehaves on single-tenant,
  the fallback is validating `tenantId` in our own middleware — a plan-level decision if it
  arises.
- App Service cold starts on the low tiers can exceed the Bot Framework's ~15 s delivery window;
  if the pilot shows dropped first messages, enable Always On (B1+) — noted in the guide, not
  engineered around here.
- A restart still forgets bindings (scope decision, §1). The guide tells operators to expect
  users re-referencing cards after each deploy.

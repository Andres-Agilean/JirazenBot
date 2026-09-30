# Deploy no Azure — registro do bot, App Service e instalação no Teams

Guia do operador para colocar o bot no Teams real. Pré-requisitos: uma assinatura Azure com
permissão para criar recursos, permissão para registrar apps no Entra ID do tenant Agilean,
acesso ao Teams admin center (ou sideloading habilitado para o piloto) e o Azure CLI (`az`) logado
(`az login`).

Convenções abaixo: grupo de recursos `rg-jirazen`, região `brazilsouth`, App Service
`jirazen-bot` (o nome vira o subdomínio `https://jirazen-bot.azurewebsites.net` e precisa ser
único no Azure — ajuste se estiver tomado, e ajuste o endpoint no passo 2 junto).

## 1. Registro Entra (identidade do bot)

```bash
az ad app create --display-name "Jirazen" --sign-in-audience AzureADMyOrg
az ad sp create --id <appId>
```

- `--sign-in-audience AzureADMyOrg` = single-tenant: só tokens do tenant Agilean são aceitos.
- Anote o `appId` da saída — ele é o **BOT_CLIENT_ID** e também o id que entra no manifest.
- `az ad sp create` cria o service principal no tenant Agilean para esse app — o portal do Azure
  faz isso implicitamente ao registrar um app, mas o CLI não; sem ele o fluxo de client credentials
  falha com AADSTS700016, e o sintoma (mensagens chegam, nada volta) engana como se fosse secret
  expirado.
- Tenant id: `az account show --query tenantId -o tsv` — é o **BOT_TENANT_ID**.

Crie o secret (o **BOT_CLIENT_SECRET**; máximo 2 anos — agende a rotação):

```bash
az ad app credential reset --id <appId> --years 2 --display-name jirazen-bot
```

Anote `password` da saída AGORA — não é recuperável depois, só recriável.

## 2. Recurso Azure Bot

```bash
az group create --name rg-jirazen --location brazilsouth
az bot create --resource-group rg-jirazen --name jirazen-bot --sku F0 \
  --app-type SingleTenant --appid <appId> --tenant-id <tenantId> \
  --endpoint https://jirazen-bot.azurewebsites.net/api/messages
az bot msteams create --resource-group rg-jirazen --name jirazen-bot
```

O segundo comando habilita o canal Teams. O endpoint aponta para o App Service do passo 3
(ainda não existe — sem problema, o registro aceita).

## 3. App Service

```bash
az appservice plan create --resource-group rg-jirazen --name plan-jirazen --sku B1 --is-linux
az webapp create --resource-group rg-jirazen --plan plan-jirazen --name jirazen-bot \
  --runtime "NODE:22-lts"
az webapp config set --resource-group rg-jirazen --name jirazen-bot --always-on true
```

- **B1 + Always On**: no F1/D1 o processo hiberna e o cold start pode estourar a janela de
  entrega do Bot Framework (~15 s) — a primeira mensagem some. Always On evita.

Configure TODAS as variáveis (as do `.env` local MAIS as três do bot; `ALLOW_UNAUTHENTICATED`
NUNCA é definida aqui):

```bash
az webapp config appsettings set --resource-group rg-jirazen --name jirazen-bot --settings \
  ATLASSIAN_SITE_URL=... ATLASSIAN_CLOUD_ID=... ATLASSIAN_EMAIL=... ATLASSIAN_API_TOKEN=... \
  ATLASSIAN_ALLOWED_PROJECTS=... ZENDESK_SUBDOMAIN=... ZENDESK_EMAIL=... ZENDESK_API_TOKEN=... \
  ZENDESK_JIRA_EXTERNAL_ID=... RESOLVER_ORDER=jira_zendesk_id_field,zendesk_links \
  JIRA_ZENDESK_ID_FIELD=customfield_10356 ANTHROPIC_API_KEY=... \
  BOT_CLIENT_ID=<appId> BOT_CLIENT_SECRET=<password> BOT_TENANT_ID=<tenantId> \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

`SCM_DO_BUILD_DURING_DEPLOYMENT=true` faz o Oryx rodar `npm install` no deploy;
o app inicia com `npm start` (script padrão detectado). Sem passo de build — tsx resolve
TypeScript em runtime, igual ao local.

## 4. Deploy do código

Na raiz do repositório:

```bash
git archive --format=zip -o deploy.zip HEAD
az webapp deploy --resource-group rg-jirazen --name jirazen-bot --src-path deploy.zip --type zip
```

Verifique o log de inicialização:

```bash
az webapp log tail --resource-group rg-jirazen --name jirazen-bot
```

Esperado: `Modo autenticado: validação de token do Bot Framework ativa.` seguido de
`Bot ouvindo em ...`. Se aparecer o erro pt-BR de credenciais, alguma das três variáveis BOT_*
está faltando ou com espaço — o bot se recusa a iniciar de propósito.

## 5. Instalar no Teams

1. Siga `appPackage/README.md`: coloque o `<appId>` nos dois campos do manifest e gere o zip.
2. **Piloto (sideload):** Teams → Apps → Gerenciar seus aplicativos → Carregar um aplicativo →
   Carregar um aplicativo personalizado → selecione o zip. Requer política de sideloading.
3. **Org toda:** Teams admin center (admin.teams.microsoft.com) → Teams apps → Manage apps →
   Upload new app → zip → depois defina a política de disponibilidade.

## Pré-requisitos do lembrete por DM

O comando `lembrar responsável` envia mensagens diretas no Teams. Requer:

- **Recurso Azure Bot Service** (passo 2) com canal Teams
- **App instalado** (passo 5) para usuários-alvo ou com política de instalação proativa
- **Permissão Graph `User.Read.All`** na app Jirazen (`74ca1161-1764-4572-842b-368705913b95`)
  com consentimento do admin

**Verificação ao vivo:** confirme que Teams aceita o id Microsoft Graph como membro da conversa 1:1.
Se o método SDK falhar, pode exigir o id prefixado `29:` (Teams id); nesse caso, adicione um
lookup Graph → Teams-id no sender (`src/teams/app.ts`).

## 6. Smoke test

1. DM com o bot: `QZ-252` → resumo com rodapé e botões; uma pergunta de follow-up.
2. Num canal (bot adicionado à equipe): `@Jirazen QZ-252 qual o status?` → resposta SEM notas
   internas do Zendesk (a regra de superfície, verificada pela primeira vez no Teams real).
3. O indicador de digitação aparece — no Teams real ele funciona (no Playground não).

## 7. Operação

- **Rotação do secret, sem derrubar o bot:** rodar `az ad app credential reset` sem `--append`
  (como no passo 1) revoga TODOS os secrets existentes na hora, derrubando o bot em produção até a
  variável nova ser configurada. Em vez disso:
  1. `az ad app credential reset --id <appId> --append --years 2 --display-name jirazen-bot-<data>`
     — `--append` mantém o secret antigo válido enquanto o novo é distribuído.
  2. Atualize `BOT_CLIENT_SECRET` no App Service com o novo `password` e reinicie
     (`az webapp restart --resource-group rg-jirazen --name jirazen-bot`).
  3. Confirme no `az webapp log tail` que o bot volta a responder com o secret novo.
  4. Só então revogue o antigo: `az ad app credential delete --id <appId> --key-id <keyId>` (o
     `keyId` do secret antigo sai de `az ad app credential list --id <appId>`).

  Quando um secret expira sem rotação, o bot não consegue responder (erro 401 ao ENVIAR) — as
  mensagens chegam mas nada volta; esse é o sintoma.
- **401 nos logs ao receber** = token de entrada rejeitado (config errada de tenant/app id).
  **Timeout/sem resposta no Teams** = endpoint errado no recurso Bot ou app parado.
- **Deploy reinicia o processo e apaga os bindings** (armazenamento em memória, decisão da fase):
  usuários simplesmente referenciam o card de novo.
- Logs: `az webapp log tail`, ou Log Stream no portal.

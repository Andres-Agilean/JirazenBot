# Pacote do app Teams

Três arquivos que viram o zip instalado no Teams. Antes de zipar:

1. Substitua os DOIS campos `00000000-0000-0000-0000-000000000000` em `manifest.json`
   (`id` e `bots[0].botId`) pelo client id do app Entra — o mesmo valor nos dois.
2. (Opcional) Troque `color.png`/`outline.png` por ícones reais — 192×192 e 32×32;
   o outline precisa ser branco com fundo transparente.
3. Zipe os TRÊS arquivos na RAIZ do zip (sem pasta interna):

   PowerShell: `Compress-Archive -Path appPackage/manifest.json, appPackage/color.png, appPackage/outline.png -DestinationPath jirazen-teams.zip -Force`

Um zip com uma pasta dentro é o erro de instalação mais comum ("manifest not found").
Instalação: docs/deploy-azure.md, passo 5.

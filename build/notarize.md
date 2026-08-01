# Assinatura & Notarização do NexusIDE (macOS)

Para que o `.dmg` abra **limpo em qualquer Mac** (sem o erro "está danificado"
nem "desenvolvedor não identificado"), o build precisa ser **assinado com um
Developer ID Application** e **notarizado pela Apple**.

Isso já está cabeado no `forge.config.ts`: o alvo publicável exige o certificado
`Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)` e ativa
hardened runtime/notarização apenas com `NEXUS_MAC_PUBLISH_RELEASE=1`, Team ID
exato e o perfil exato `"nexus-notary"`. Sem isso, somente `npm run make`
produz assinatura **ad-hoc** (`identity: -`) para smoke local. `make:release`
falha; pacote ad-hoc não pode ser publicado.

## Pré-requisitos (uma vez só)

### 1. Certificado Developer ID Application
1. Gere uma CSR (Certificate Signing Request):
   - Abra **Acesso às Chaves** → menu **Acesso às Chaves → Assistente de
     Certificado → Solicitar um Certificado de uma Autoridade de Certificação**
   - E-mail: seu Apple ID · Nome comum: seu nome · marque **Salvo em disco**
2. No portal <https://developer.apple.com/account/resources/certificates/list>:
   - **+** → **Developer ID Application** → envie a CSR → baixe o `.cer`
3. Duplo-clique no `.cer` para instalar no Keychain **login**.
4. Confirme: `security find-identity -v -p codesigning` deve listar
   `Developer ID Application: Seu Nome (TEAMID)`.

### 2. Perfil `"nexus-notary"` no Keychain

O nome do perfil local desta release é **exatamente** `nexus-notary`, incluindo
o hífen. Sempre o coloque entre aspas no shell.

1. Em <https://appleid.apple.com>, abra **Login e Segurança → Senhas de app** e
   gere uma senha de app para a notarização.
2. Grave a credencial de forma interativa. O `notarytool` solicitará Apple ID,
   Team ID e senha sem exigir que o segredo seja colocado na linha de comando:

   ```bash
   xcrun notarytool store-credentials "nexus-notary"
   ```

3. Valide o perfil sem imprimir nem exportar a senha:

   ```bash
   xcrun notarytool history --keychain-profile "nexus-notary"
   ```

Nunca use `--password`, `APPLE_APP_SPECIFIC_PASSWORD` ou a senha de app em um
comando copiado para histórico, arquivo, log ou commit.

### 3. Team ID
- Aparece entre parênteses no nome do certificado, ou em
  <https://developer.apple.com/account> → **Membership**.

## Release manual local — caminho principal

Esta release é construída, verificada e publicada **localmente**. Não execute
`gh workflow run`, não dispare o workflow de release e não dependa de GitHub
Actions.

Use exatamente Node `22.23.1`, fixado em `package.json > nexusRelease.node`.
`make:release` e o gate de segurança baixam o pacote npm na versão declarada por
`packageManager`, conferem o SHA-512 fixado em
`build/release-npm-integrity.json` e o executam em cache temporário privado. O
npm global não é atualizado nem usado para resolver dependências da release.

O fluxo abaixo produz **somente a arquitetura do Mac de release**. No Mac
Apple Silicon oficial, o candidato é `arm64`; este runbook não promete binário
universal nem `x86_64`. Uma distribuição Intel exigiria um build e uma prova
separados em host Intel, não a reutilização dos artefatos arm64.

Finalize e faça commit da versão antes de começar. A tag local precisa apontar
para `HEAD`; ela só é enviada ao remoto depois de todos os gates. O working tree
deve estar limpo inclusive quanto a arquivos não rastreados (saídas ignoradas e
`release-artifacts/` gerado pelo próprio gate são as únicas exceções fechadas):

```bash
npm ci
npm run typecheck
npm test

release_tag="v$(node -p "require('./package.json').version")"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git tag -a "$release_tag" -m "NexusIDE $release_tag"
test "$(git rev-parse "$release_tag^{commit}")" = "$(git rev-parse HEAD)"

# TSA da Apple derruba rajadas de `codesign --timestamp` (muitos nativos
# unpacked) e o build falha com "A timestamp was expected but was not
# found" — sempre no mesmo arquivo. O wrapper de retry resolve:
mkdir -p scripts/codesign-retry-bin
ln -sf ../codesign-with-retry.sh scripts/codesign-retry-bin/codesign

env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  NEXUS_MAC_PUBLISH_RELEASE=1 \
  APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE='nexus-notary' \
  PATH="$PWD/scripts/codesign-retry-bin:$PATH" \
  npm run make:release

# Verifica DMG e ZIP nos caminhos aninhados de out/make, prova a missão real
# no .app desse mesmo build e finaliza manifesto/recibos com os hashes.
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  NEXUS_MAC_PUBLISH_RELEASE=1 \
  APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE='nexus-notary' \
  npm run release:candidate

# Restaura o ABI do Node para continuar o desenvolvimento local.
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID \
  npm run rebuild:node
```

A notarização adiciona alguns minutos (upload + validação da Apple). O Forge faz
o *staple* do ticket no `.app`, gera DMG/ZIP e, no `postMake`, notariza e faz
*staple* também no container DMG. Se o perfil não existir ou a Apple rejeitar a
submissão, o build deve falhar; pacote ad-hoc nunca é promovido.

## Verificar antes de distribuir

O comando manual equivalente abaixo é útil para diagnóstico; o gate canônico é
`npm run release:candidate`, que também executa o E2E e amarra as evidências:

```bash
node scripts/verify-macos-release.mjs \
  --artifacts out/make \
  --version "$(node -p "require('./package.json').version")" \
  --bundle-id com.nexuside.app \
  --team-id 35P5XL3JN6 \
  --identity "Developer ID Application: Cleofas Pereira rocha" \
  --arch arm64
```

O verificador procura recursivamente nos caminhos aninhados de `out/make` e
exige exatamente um DMG e um ZIP (o ZIP alimenta o Squirrel.Mac). Antes
de montar, valida assinatura, Authority/TeamIdentifier, Gatekeeper e ticket
stapled do próprio container DMG. Depois monta o DMG como somente leitura e
extrai o ZIP em diretório temporário. Em **cada** app contido revalida versão,
bundle ID, assinatura strict de todos os Mach-O, Gatekeeper, ticket stapled,
entitlements por tipo de processo, fuses e o smoke isolado com userData
temporário. Também exige que todos os Mach-O sejam da única arquitetura
declarada e que os apps extraídos do DMG e do ZIP sejam coerentes. Só depois
disso os artefatos podem ser publicados.

Os perfis de entitlement são deliberadamente separados:

- app principal e Renderer Helper: V8 JIT + entrada de áudio (o Renderer
  executa `getUserMedia`/WebAudio);
- helpers GPU/utility: apenas V8 JIT;
- helper Plugin: apenas memória executável exigida pelo helper;
- frameworks, dylibs, módulos nativos e crashpad: nenhum entitlement.

Nenhum perfil permite variáveis DYLD, desabilita library validation ou
desabilita executable-page protection.

## Publicação manual no GitHub Release

Publique somente pelo alvo abaixo. Ele repete fail-closed o gate do candidato,
envia a tag exata e chama `gh release create` diretamente; não inicia GitHub
Actions e inclui DMG, ZIP, auditorias runtime/toolchain, SBOMs, manifesto,
evidência E2E e recibo do candidato:

```bash
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD \
  NEXUS_MAC_PUBLISH_RELEASE=1 \
  APPLE_TEAM_ID=35P5XL3JN6 \
  APPLE_KEYCHAIN_PROFILE='nexus-notary' \
  npm run release:publish
```

A tag deve existir apenas localmente e resolver a `HEAD` ao entrar no comando;
o script a envia somente após assinatura/notarização, verificação e E2E. Não
use `gh release create` à mão. O workflow anterior está arquivado fora de
`.github/workflows` e não é executável pelo GitHub Actions.

## Um `make:release` por vez na máquina

O comando isola o *checkout* num worktree git temporário — por isso ele nunca
corrompe `node_modules` nem a árvore principal. Mas o `electron-packager` usa
uma raiz temporária **compartilhada do sistema** (`$TMPDIR/electron-packager/`).
Dois builds simultâneos escrevem lá dentro e a limpeza de um remove a árvore do
outro no meio da assinatura.

O sintoma é enganoso e manda quem diagnostica para o lado errado — parece
certificado ou corrupção de assinatura:

```
codesign … NexusIDE Helper (Renderer): replacing existing signature
codesign … NexusIDE Helper (Renderer): No such file or directory
```

O arquivo desaparece entre o início e o fim da própria assinatura. O
isolamento de git não protege contra isso.

Antes de começar, confirme que a máquina está vazia — inclusive de apps de E2E
ainda drenando, que continuam disputando o mesmo temp:

```bash
pgrep -fl "make-release|electron-forge|electron-packager|release-candidate-gate|publish-release|nexus-release-e2e"
```

O mesmo vale para dois `release:publish` simultâneos: cada um reexecuta a
missão real por conta própria.

## Pendência: esgotamento de provider não é observável antes do gate

Cada ciclo do gate roda uma missão real com CLIs de verdade (codex, claude,
grok, glm, agy, opencode). Depois de várias execuções seguidas, os provedores
começam a não responder e a missão degrada de forma monotônica — observado numa
noite de release, no MESMO commit e MESMOS artefatos:

| Execução | Missão | Panes | Dispatches | Handoffs |
|---|---|---|---|---|
| 1 | `done` | 4 | 8 | 8 |
| 2 | `running` | 3 | 7 | 7 |
| 3 | `blocked` | 3 | 6 | 5 |

O recibo da terceira nomeou a causa: *"O worker não entregou um handoff após 3
tentativas físicas… Última causa: O worker ficou sem atividade e sem heartbeat
por 10 minutos (stalled)"*.

Isso **não é bug de código** — é desgaste de ambiente. Mas hoje só se descobre
~40 minutos depois de iniciar o ciclo, e a tabela `accounts` do `nexus.db` não
revela: ela cobre as contas do vault, enquanto grok, glm, agy, opencode e codex
autenticam pelos próprios HOMEs.

**A fazer**: uma checagem de saúde de provider antes do gate, que falhe rápido
com "provedor X não responde" em vez de custar um ciclo inteiro. Enquanto não
existir, espace os ciclos de release quando um falhar por worker stalled.

## Limite de assinatura Windows

A release canônica não executa o CodeSignTool/eSigner 1.3.3. Essa versão aceita
usuário, senha e TOTP apenas por argumentos de linha de comando, o que exporia
segredos na lista de processos. Até existir uma integração que receba
credenciais por canal seguro, assinatura e publicação Windows falham de forma
fechada; nenhum script local de compatibilidade faz parte do fluxo autorizado.

## Canal de atualização

Assinar e publicar um ZIP não cria, por si só, auto-update para usuários finais.
O app só usa Squirrel diretamente quando recebe um `NEXUS_UPDATE_FEED` HTTPS
confiável. Sem esse feed, o caminho alternativo depende de `gh` autenticado e é
adequado apenas para instalações de desenvolvimento do repositório privado.
Antes de prometer atualização automática, provisione e teste o feed em um
domínio Nexus confiável. Este fluxo gera hoje apenas o ZIP `darwin-arm64`;
`darwin-x64` continua indisponível até receber build e prova próprios.

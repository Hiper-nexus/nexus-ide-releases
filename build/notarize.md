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

## Um comando, de dentro do Nexus ou do Terminal: `npm run release:mac`

Depois de commitar versão, CHANGELOG e release notes e criar a tag anotada
local, rode:

```bash
npm run release:mac                              # build → gate → publicação macOS
npm run release:mac -- --from candidate          # artefatos já em out/make: pula o build
npm run release:mac -- --from candidate --no-publish   # só o gate
```

O comando sobe um job do launchd de uma execução (`KeepAlive=false`), repassa
o log do job em primeiro plano e sai com o código das etapas. Cada etapa só
roda se a anterior passar, e `rebuild:node` roda sempre no fim. Ele usa o
Node fixado em `nexusRelease.node` (ou `NEXUS_RELEASE_NODE=/caminho/node`),
a home real do usuário e o `PATH` do shell de login, e nunca repassa
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`. Recusa se outra release estiver
carregada ou rodando.

**Por que launchd.** Dentro de um pane do Nexus, todo processo tem o
`nexus-pty-supervisor` do pane como "processo responsável" do macOS. O app
empacotado lançado dali herda esse responsável e o supervisor dele recusa
abrir terminal (`responsible_is_supervisor` em
`/tmp/nexus-pty-launch-auth-fail.log`). O smoke do gate morre em
`dictation-hold-to-talk (write-refused-exited)`. Um job do launchd nasce com
a cadeia de responsabilidade limpa, como o app aberto pelo Finder. Os
comandos manuais abaixo continuam valendo fora de um pane.

## Release manual local — caminho principal

Esta release é construída, verificada e publicada **localmente**. Não execute
`gh workflow run`, não dispare o workflow de release e não dependa de GitHub
Actions.

Use exatamente Node `22.23.2`, fixado em `package.json > nexusRelease.node`.
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
`npm run release:candidate`, que verifica o build assinado, faz staple, roda o
smoke no ZIP selado e amarra o receipt:

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

`make:release` valida o perfil `nexus-notary`, a disponibilidade do
`notarytool`/`stapler` e a identidade Developer ID **antes** de criar o
worktree temporário ou baixar dependências. Credencial removida/revogada e
certificado sem chave privada falham rápido, em vez de desperdiçar o build
inteiro para só então descobrir que a Apple não pode receber o artefato.

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

**Estado**: o núcleo de decisão existe em
[`scripts/release-provider-preflight.mjs`](../scripts/release-provider-preflight.mjs).
Ele classifica cada provedor em `healthy` / `absent` / `unresponsive` /
`unauthenticated` e consolida o veredito do ciclo:

- `absent` **não** bloqueia — CLI não instalada já é tratada pelo roster, e
  reprovar aqui travaria o gate por um provedor que a missão nem usaria;
- `timedOut` é o sinal mais valioso: é a forma exata que o esgotamento assume;
- auth e indisponibilidade são separadas porque o remédio difere (relogar vs
  esperar a cota);
- sonda que explode conta como não-responsiva — o gate não começa apostando
  que o provedor está bem.

**Desde a 0.20.3 a sonda viva está ligada ao gate** (codex/grok/claude
calibradas em `PROVIDER_PROBE_SPECS`; agy/kimi/glm/opencode permanecem
não-calibradas de propósito — ver `PROVIDER_PROBE_UNCALIBRATED` e o porquê de
cada uma). Regra permanente: nenhuma CLI vira bloqueio sem o comando de sonda
validado contra provedor **saudável** — preflight mal calibrado reprova release
boa, que é pior que o problema.

Quando mesmo assim um ciclo falhar por worker stalled, **espace o próximo.**
Disparar de novo em seguida degrada mais.

## Variante claude-orquestrador: skip declarado até o wiring de hooks ser provado

Na 0.20.3 a variante claude-orquestrador do gate reprovou 2/2 com a mesma
assinatura: `invariant-failed`, missão `blocked` por
`orchestrator_session_exited_before_first_dispatch`, kickoff
`recusado (timeout)` com `turnStart=0/0` — e diagnóstico post-mortem provou que
**o claude estava saudável** (mesma HOME preservada respondeu `claude -p` na
primeira; auth, trust e onboarding corretamente semeados pelo harness). A
mensagem do kickoff ENTROU na sessão do claude (user message no transcript da
sessão), mas nenhum evento `UserPromptSubmit` chegou ao canal de hooks — a
missão morreu esperando um sinal que o wiring nunca entregou.

Contexto que explica por que ninguém viu antes: a variante nasceu na campanha
da 0.20.2 **com o claude desta máquina quebrado** — ela passou a vida
skip-declarada e a 0.20.3 foi seu primeiro exercício real. O elo exato do
wiring (settings do overlay vs `--settings` vs servidor de hooks) não pôde ser
provado post-mortem porque o teardown limpa os arquivos token-scoped de
`~/.nexus/mcp-configs/`.

Decisão operacional (0.20.4):

- A variante volta a **skip declarado** (`NEXUS_REAL_MISSION_ADVISOR_SKIP`
  contendo `claude` antes do gate) — o mecanismo honesto da 0.20.2: o skip
  entra na evidência (`skippedOrchestrators`) e aparece no publish.
- O refusal do kickoff agora registra `hooks=` (canal-vivo vs
  nenhum-evento-recebido) — `src/main/orch/mission-kickoff.ts`. Na próxima
  tentativa da variante, a recusa nomeia qual metade quebrou em vez de exigir
  arqueologia de userData.
- Reativar a variante exige: exercitá-la em dev com claude saudável, ler o
  `hooks=` da recusa (se recusar) e provar o elo quebrado. Só então remover o
  skip.

## Assinatura e prontidão Windows

CodeSignTool/eSigner 1.3.3 continua fora do fluxo autorizado: senha e TOTP em
argumentos expõem segredos na lista de processos. A alternativa implementada é
CKA pré-configurado no Windows Certificate Store, selecionado apenas pelo
thumbprint público. Consulte [o fluxo Windows](../docs/WINDOWS-PREVIEW-AND-SIGNING.md)
e [a publicação conjunta](../docs/RELEASE.md).

O worker protegido, a autenticação CKA e a proteção de main ainda precisam ser
provisionados; nenhuma credencial foi instalada por essa implementação. O
candidato privado pode ser construído e validado com assinatura e smoke. Para
publicação, o recibo autenticado também precisa conter prova real de instalação
e upgrade assinado N→N+1, vinculada à versão, commit, run e hashes dos três
artefatos. O coletor atual registra `installedUpgradeVerified=false`, portanto
**não autoriza publicação pública**, mesmo quando assinatura e smoke passarem.
Não transforme esse campo em true sem implementar e executar o teste real.

## Canal de atualização

Mac mantém a descoberta via gh privado e fallback anônimo no espelho público,
com instalação por Squirrel.Mac. Windows x64 instalado usa o serviço oficial
Electron apontado ao repositório público de releases, com Setup, NUPKG completo
e RELEASES publicados juntos. A disponibilidade desse código não comprova
upgrade instalado; a prova obrigatória acima permanece pendente.

O publicador local usa um lock compartilhado por todas as checkouts da conta
de release e consulta novamente as versões estáveis dos dois repositórios
imediatamente antes de tornar cada draft público. Não execute publicadores em
hosts diferentes simultaneamente: o lock é local, não distribuído. Em caso de
crash, confirme que o PID em owner.json terminou antes de remover manualmente
o lock informado pelo erro; nunca há tomada automática por timeout.

### Transporte de timestamp em redes com IPv6 indisponível

Depois de uma falha explícita do TSA, o wrapper resolve um endereço IPv4 público
de `timestamp.apple.com` e repete usando esse endereço do próprio serviço da Apple.
Não altera a rede do sistema, não usa outro TSA e não desativa o timestamp.
URLs de timestamp explicitamente configuradas pelo chamador são preservadas.
A assinatura ainda precisa passar na verificação estrita, conter `Timestamp=` e
ser aceita pela notarização e pelo Gatekeeper. O perfil permanece `nexus-notary`.

Em 6/9/2026, o POST RFC3161 por IPv6 expirou; IPv4 recebeu `Granted`. O mesmo
módulo nativo que falhava pelo hostname assinou e verificou com o IPv4 resolvido.

# Publicar uma nova versão

Checklist funcional da candidata **0.60** (ainda em aberto):
[`RELEASE-0.60.md`](../RELEASE-0.60.md).

As publicações são **independentes por sistema operacional**. O Windows usa a
candidata produzida pelo workflow privado protegido
`windows-release.yml` e a publica com `npm run release:publish:windows`; esse
comando não inicia nem exige build, assinatura ou notarização macOS. O Mac usa
seu próprio caminho de Developer ID/notarização e publica com
`npm run release:publish:macos`, que consome só a candidata local já aprovada
pelo gate (`npm run release:candidate`) e não exige nem aguarda um run
Windows. O Linux usa o workflow `linux-release.yml` em runner hospedado
`ubuntu-22.04` e publica com `npm run release:publish:linux`. Os publicadores
fixam `--repo` em toda chamada ao `gh`; não dependem do repositório inferido
pelo diretório atual.

## Canal Linux independente

Uma publicação Linux usa somente os artefatos x64 que o workflow
`linux-release.yml` produziu para a tag anotada: `.deb`, `.rpm` e ZIP
portátil com os nomes do Electron Forge (`nexus-ide_<v>_amd64.deb`,
`nexus-ide-<v>-1.x86_64.rpm` e `NexusIDE-linux-x64-<v>.zip`), mais
`SHA256SUMS-linux-x64.txt` gerado pelo publicador. O workflow verifica a tag anotada, o commit na `main` protegida,
o Node de `nexusRelease.node`, roda o smoke empacotado sob `xvfb-run` e ainda
instala o `.deb` e abre o aplicativo extraído do ZIP no próprio runner antes
de publicar os artifacts. O recibo `nexus.linux-release/v2` exige os três
formatos e a prova `zipExtracted`. Recibos históricos `v1` continuam aceitos
explicitamente apenas com o par DEB/RPM; um preview nunca é publicável.

Para disparar a build Linux de uma versão já tagueada:

```bash
gh workflow run linux-release.yml -R Hiper-nexus/nexus-ide --ref main -f version=<v>
```

Depois de o run concluir com sucesso, publique com:

```bash
npm run release:publish:linux -- --version <v> --run <id-do-run>
```

A tag construída precisa conter os scripts de coleta e validação do respectivo
contrato; o workflow não injeta ferramentas novas num fonte histórico. O
preview permite provar o fonte atual antes de criar uma nova versão/tag.

### Sem GitHub Actions: build em container (Docker)

O Actions é caro e para de iniciar jobs quando a cobrança trava (02/10/2026: a
organização gastou o limite com CodeQL, CI e previews a cada push no `main`).
Para esse caso, e para uma VPS própria depois, existe o mesmo build num container
`ubuntu:22.04`:

```bash
git fetch --tags
scripts/build-linux-release-docker.sh <v> [saída]     # DOCKER="sudo docker" se preciso
```

O container espelha o `linux-release.yml`: tag anotada na ancestralidade da
`main`, Node exato de `nexusRelease.node` com SHA-256 conferido, npm fixado,
`npm ci`, typecheck, sinks do renderer, `npm test`, `release:security`, build,
smoke do app empacotado, do DEB instalado e do ZIP extraído, e o teto de glibc
2.35. Roda como usuário comum com `sudo`, Git recente e `LANG=C.UTF-8`, como o
runner. A saída traz os três pacotes, `SHA256SUMS-linux-x64.txt` e
`build-provenance.json`.

Limites que importam:

- **Não gera o recibo `nexus.linux-release/v2`.** Ele prova um run do workflow, e
  `release:publish:linux` o exige. A publicação é manual: criar a release nos dois
  repositórios, `gh release upload` dos quatro arquivos (nunca `--clobber`),
  conferir o `digest` de cada asset e dizer nas notas que o build foi local.
- **Tag imutável com teste quebrado já corrigido depois (caso real: `v0.76.191` e o F-916).**
  A suíte não pode ser pulada às cegas. `KNOWN_TEST_FAILURE_FILE=<arquivo de teste>` e
  `KNOWN_TEST_FAILURE_MATCH=<trecho exato da mensagem>` fazem o container rodar a suíte SEM
  esse arquivo e rodá-lo à parte, e ele precisa falhar com exatamente esse trecho e nenhuma
  outra falha; senão o build aborta. A exceção vai para `build-provenance.json`
  (`knownTestFailure`) e DEVE constar nas notas da release.
- **Não compile no Arch/Omarchy para distribuir.** A glibc de lá é nova demais e
  os módulos nativos quebram em Ubuntu 22.04 e Debian 12.
- **O repositório NÃO pode ser montado em `/repo`:** testes usam esse caminho como
  raiz fictícia de projeto e passam a ler a pasta de verdade. O script monta em
  `/source-ro`.
- **`sudo` guarda a credencial por processo pai.** Rode o driver com `source` no
  mesmo shell em que fez `sudo -v`; um script filho pede a senha de novo.
- Depois de gerar, instale os pacotes de verdade em containers de cada distro
  (Debian 12, Ubuntu 22.04 e 24.04, Fedora) e abra o app. Foi assim que se achou o
  `alsa-lib` que faltava no RPM (F-763).

O publicador revalida o run (workflow, `workflow_dispatch` na `main`,
conclusão `success`), baixa os artifacts, confere o recibo contra a tag
anotada local (commit e objeto de tag), reconfere bytes e SHA-256 de cada
arquivo e exige o inventário exato de cada schema antes de anexar deb, rpm,
ZIP (v2) e `SHA256SUMS-linux-x64.txt` na release já publicada da canônica e, em seguida,
do espelho público. Um asset com o mesmo nome só é ignorado quando o digest
remoto bate; nunca usa `--clobber` e nunca apaga assets.

No Linux, o ZIP portátil instalado em uma pasta gravável pelo usuário usa
auto-update (`linux-self`, F-940): o app confere a assinatura Ed25519 e o ZIP
antes de trocar a instalação. DEB/RPM em diretórios do sistema continuam no
canal manual: o app avisa sobre a atualização e oferece a orientação de
instalação pelo sistema. Os dois pacotes declaram `bubblewrap` como dependência
de runtime; o ZIP também precisa desse provider e das bibliotecas Linux.
Versões portáteis sem assinatura válida não podem ser aplicadas automaticamente.

### Assinar a versão para o auto-update (F-940)

Toda versão Linux publicada precisa do `SHA256SUMS-linux-x64.txt.sig`, senão o app instalado só avisa e mostra o comando
(não se atualiza sozinho). Depois do build e do teste nas distros, NO HOST (a chave privada nunca entra no container):

```bash
node scripts/sign-linux-update.mjs --sums <saída>/SHA256SUMS-linux-x64.txt   # grava <...>.sig
gh release upload v<v> -R Hiper-nexus/nexus-ide <saída>/SHA256SUMS-linux-x64.txt.sig
gh release upload v<v> -R Hiper-nexus/nexus-ide-releases <saída>/SHA256SUMS-linux-x64.txt.sig
```

A chave fica em `~/.config/nexus-release/linux-update-ed25519.pem` (0600); o script recusa outra permissão e chave que o
app não conheça. Faça backup dela: sem ela, só uma versão assinada por OUTRA chave já embutida troca de chave. Rotação:
acrescente a pública nova a `UPDATE_SIGNING_KEYS`, publique assinando com a antiga e, versões depois, retire a antiga.

### Repositórios apt e dnf (F-942)

Depois de assinar o `SHA256SUMS` (acima) e ANTES de anunciar a versão, gere e suba os metadados assinados dos repositórios,
NO HOST (a chave GPG não entra em container; use `source` por causa do `sudo`, como nos outros scripts):

```bash
export DOCKER="sudo -n docker"; source scripts/build-linux-repo.sh <saída do build> <saída>/repo   # confere a assinatura sozinho
for f in <saída>/repo/assets/*; do
  gh release upload v<v> -R Hiper-nexus/nexus-ide "$f"; gh release upload v<v> -R Hiper-nexus/nexus-ide-releases "$f"
done
```

O Worker do site redireciona `https://nexuside.app/apt/*` e `/rpm/*` para os assets da release Linux mais nova; a release
precisa ter os TRÊS pacotes e esses metadados. Sem os metadados da versão nova, o `apt update` falha em `Hash Sum mismatch` até
eles subirem: suba-os logo depois dos pacotes. A chave GPG vive em `~/.config/nexus-release/gnupg` (0700) e expira em
2031-10-04; faça backup, e para trocá-la publique a nova em `site/public/linux/` e atualize `KEY_FPR` em `install-repo.sh`.
Quem quiser atualizações pelo sistema roda UMA vez `curl -fsSL https://nexuside.app/install-repo.sh | sh`.

### Preview Linux em PR e main

`linux-preview.yml` roda em pull requests para `main` e em pushes na `main`,
sem exigir tag, worker Windows ou credenciais de publicação. Ele usa o mesmo
runtime Node/npm verificado, constrói DEB/RPM/ZIP, roda os smokes empacotado,
DEB instalado e ZIP extraído sob Xvfb e registra o SHA exato do checkout.
O artifact `linux-x64-preview` contém os três formatos, checksums e
`linux-preview-receipt.json` (`nexus.linux-preview/v1`, `preview-only`). Seu
nome, evento e schema são recusados pelo publicador de produção.

O preview também roda o smoke funcional do navegador em Electron real e
salva `report.json` e screenshots no artifact separado `linux-browser-smoke`.
Um resultado local ou estrutural não substitui esses runs hospedados.

### ZIP portátil no Omarchy/Arch

Omarchy usa Arch e Hyprland. O ZIP oferece o aplicativo Linux x64 sem precisar
instalar um DEB/RPM. A instalação portátil pode se atualizar após conferir a
assinatura, mas não instala as dependências do sistema. No Arch,
instale o provider de sandbox pelo gerenciador de pacotes e execute o binário
extraído como seu usuário habitual:

```bash
sudo pacman -S --needed bubblewrap
unzip NexusIDE-linux-x64-<v>.zip
cd NexusIDE-linux-x64
./nexus-ide
```

No primeiro boot o app escreve a própria entrada de menu em
`~/.local/share/applications/nexus-ide.desktop` e se registra como handler de
`nexus://` — é por esse link que o navegador devolve o login (F-728). Se a
pasta mudar de lugar, basta abrir o app de novo. Para remover: apague esse
arquivo (e `~/.local/share/nexus-ide/`, se existir).

O login e as chaves de provider precisam de um Secret Service ativo
(`gnome-keyring`, que o Omarchy instala, ou KeePassXC/KWallet). Fora de GNOME e
KDE o app pede o backend libsecret por conta própria (F-729); sem Secret
Service o cofre fica indisponível e o app avisa, nunca grava em texto plano.

O `--no-sandbox` permanece exclusivo dos harnesses de teste hospedados; não faz
parte dessas instruções de lançamento normal. Consulte o
[manual do Omarchy](https://omarchy.org/manual/) e a
[documentação Wayland do Electron](https://www.electronjs.org/blog/tech-talk-wayland).

### Identidade de desktop dos pacotes

DEB e RPM instalam `/usr/share/applications/nexus-ide.desktop` com
`MimeType=x-scheme-handler/nexus;`, categoria `Development` e o ícone da marca
em `/usr/share/pixmaps/nexus-ide.png`. O nome da entrada casa com
`desktopName` do `package.json`: é dele que o Electron tira o app_id do
Wayland, a classe da janela no X11 e o alvo do registro de `nexus://`.
`scripts/verify-linux-desktop-identity.mjs` confere tudo isso sobre o pacote
instalado, nos dois workflows e no smoke do Debian 12.

### Validação em desktop real (Omarchy, 02/10/2026)

Máquina: Omarchy (Arch), Hyprland 0.56.2 em Wayland, eDP-1 1920×1080 escala
1,5, bandeja pelo `quickshell` do omarchy-shell, `gnome-keyring` ativo,
`bubblewrap` 0.12.0. Build local do fonte desta versão (`npm run package`),
com `HOME`/XDG isolados para não tocar no perfil do operador. A tela estava
bloqueada durante o teste, então tudo abaixo foi conferido por `hyprctl` e pelo
barramento D-Bus da sessão, não a olho.

Verificado:

- Smoke empacotado local (`linux: testado localmente`, 22 probes) e encerramento
  por SIGTERM sem processo órfão.
- Janela principal e diálogos com a mesma identidade `nexus-ide`, em Wayland e
  em X11 (`--ozone-platform=x11`). Antes: `nexuside` na janela principal.
- Entrada de menu criada pelo build portátil; `xdg-mime query default
  x-scheme-handler/nexus` devolve `nexus-ide.desktop`.
- Índice de tipos (F-740, 0.76.175): `gio mime x-scheme-handler/nexus` lista o
  app em "Registered applications" e
  `org.freedesktop.portal.OpenURI.OpenURI nexus://quota` entrega o link ao app
  em execução. A 0.76.170 passou no `xdg-open` e falhou no login real pelo
  Chrome ("Open With… No Apps available"), porque o Chrome abre pelo portal e
  o portal só oferece apps do índice. Teste sempre pelo portal.
- `xdg-open 'nexus://open?path=…'` com o app aberto: o link chega à instância
  em execução, o diálogo "Abrir pasta externa?" aparece e o app segue vivo
  depois de mais de 20 s com o diálogo na tela (F-731).
- Arranque a frio pelo mesmo link: o app abre e mostra o diálogo, sem cair.
- Cofre: no Hyprland o `safeStorage` sai de `basic_text` para
  `gnome_libsecret` e cifra/decifra (F-729).
- Login completo com conta real (0.76.175, feito pelo operador às 13:12 de
  02/10): Google no Chrome, retorno por `nexus://` pelo portal e sessão gravada
  no cofre (`~/.nexus/secrets.enc`) com o backend libsecret. Na 0.76.170 a
  mesma tentativa caiu no F-740.
- Instalação pelo comando do site (`curl -fsSL https://nexuside.app/install.sh
  | sh`): baixou a 0.76.175, conferiu o SHA-256 e instalou o portátil em
  `~/.local/share/nexus-ide`.
- Aviso de versão nova (F-751, 0.76.178): o app instalado (0.76.178) sobe em
  modo `manual`, consulta o espelho público e responde "na mais recente". Um
  build 0.76.176 rodando contra o espelho de verdade passou para `available`
  com a 0.76.178 (log `check:available`). A atualização 0.76.175 → 0.76.178 foi
  feita pelo `install.sh` do site. NÃO visto a olho: o painel com o comando e o
  botão "Copiar comando".
- Clique no ícone do Redline (F-750, 0.76.178), visto a olho com mouse e
  teclado reais (`ydotool`, sessão desbloqueada, 02/10 15:05): o ícone está na
  gaveta da seta `<` da barra do Omarchy com o tooltip "Nexus Redline · 4
  contas · 100% em Codex"; o clique esquerdo trouxe o Nexus à frente e, partindo
  de Início, levou a Configurações › Uso e cotas e atualizou as cotas.
- Painel de atualização (F-751, 0.76.178), visto a olho: "atual v0.76.178 · você
  está na mais recente", a explicação de que no Linux é manual e o botão
  "Verificar agora", sem texto de erro; o botão disparou uma nova consulta no
  log (`check:start`). O bloco com o comando e o "Copiar comando" só aparece com
  versão nova e não foi visto na interface; o caminho de dados dele foi
  verificado com o build 0.76.176 contra o espelho público.
- Redline ligado por padrão (F-739, 0.76.175): sem preferência salva o item
  aparece no boot. Depois do login, "Uso e cotas" mostra a bandeja como ativa.
- Redline: item registrado no `org.kde.StatusNotifierWatcher`, tooltip e menu
  com as contas, atualização ao gravar um snapshot novo, "Atualizar agora"
  consumido pelo Nexus, "Ocultar da bandeja" persiste e remove o item.
- `bwrap` executa o mesmo comando de `processSandboxRuntimeAvailable`; a suíte
  `npm test` roda nesta máquina com os testes de sandbox que o runner
  hospedado pula.
- Redline na barra do Omarchy (F-934, 05/10, Omarchy 4.0.4 com quickshell, NÃO
  Waybar): o item da bandeja estava ativo, com tooltip e menu certos, mas só a
  seta `<` aparece na barra (captura com `grim`); o ícone fica escondido na
  gaveta. `nexus-ide --redline-status`, medido sob o Electron de verdade com o
  bundle do Main gerado pelo Vite: ~340 ms, código 0, uma linha de JSON, sem
  janela e sem stderr. O instalador, rodado contra uma CÓPIA do `shell.json` do
  dono, mudou só 7 linhas (o módulo, depois da bandeja), foi idempotente na 2ª
  execução e a desinstalação devolveu o arquivo idêntico. Com o módulo no
  `shell.json` real (backup e volta ao original byte a byte), o quickshell
  (pid pai) chamou `--redline-status` a cada 30 s (19:06:38, 19:07:08,
  19:07:38 e 19:08:08) e parou depois da volta.

Não verificado nesta máquina (não anuncie como testado):

- Como o módulo `nexus-redline` APARECE na barra do Omarchy (texto, cor da
  classe `active`, tooltip, clique): a tela estava bloqueada na validação de
  05/10, então só se provou que a barra executa o comando. O log do shell traz
  um `TypeError: Cannot assign to read-only property "moduleName"` em
  `plugins/bar/Bar.qml[2004]` ao criar o módulo; é a injeção de propriedades do
  próprio Omarchy num módulo `command` (a propriedade é `readonly`) e não se
  provou que ele não afeta a exibição. Repetir com a tela desbloqueada:
  `nexus-ide --redline-bar-install`, `grim -g "700,0 580x40" -s 2 barra.png`.
- Aparência do ícone do Redline na barra e o clique com o mouse (tela
  bloqueada); missão com agentes reais;
  instalação do DEB/RPM (Arch não tem `dpkg`/`rpm`; isso fica com o workflow e
  o smoke do Debian 12); GNOME, KDE Plasma e XFCE; `xdg-open` com `Exec` entre
  aspas, que o xdg-utils genérico não entende — por isso a entrada portátil usa
  caminho cru ou um symlink de nome simples.

## Canal Windows independente

Uma publicação Windows usa somente a candidata Windows x64 do mesmo commit e
tag estável. A release canônica privada recebe `Setup.exe`, NUPKG, `RELEASES`,
o recibo e, quando autorizado, o waiver de prova de upgrade. O espelho
público recebe **somente** `Setup.exe`, NUPKG e `RELEASES`. Assim o feed
Squirrel Windows fica disponível sem aguardar um artefato de macOS.

**Sem assinatura Authenticode desde 05/10/2026.** O eSigner da SSL.com cobrava
por assinatura e cada build assina dezenas de arquivos, o que gerou faturas de
excesso; ele foi removido do fluxo. Quem baixa o `Setup.exe` pelo site vê o aviso
do SmartScreen ("O Windows protegeu o computador" → "Mais informações" →
"Executar assim mesmo"). No Windows 11 com o Controle Inteligente de Aplicativos
(Smart App Control) ligado, não há esse botão: o app sem assinatura é bloqueado
até o usuário desligar o recurso em Segurança do Windows. Quem já tem o Nexus
instalado atualiza pelo Squirrel. A versão assinada é a da Microsoft Store, que
reassina o MSIX de graça (guia em `docs/windows-signing/MICROSOFT-STORE.md`, que
chega com a branch `claude/ssl-code-signing-yubikey-ce1859`). Não religue o
eSigner: o workflow para se `NEXUS_WINDOWS_RELEASE_SIGNING` ou
`WINDOWS_CERTIFICATE_FILE` aparecer no ambiente do worker, e o `forge.config.ts`
recusa o certificado do eSigner.

O repositório público é compartilhado, mas cada atualizador seleciona apenas o
asset compatível: uma release macOS sem Setup Windows não avança o canal
Windows, e uma release Windows sem ZIP macOS não é oferecida a Macs. Nunca
adicione assets de outro sistema depois de uma release pública; cada sistema
publica sua própria próxima versão estável.

No host Windows de publicação, rode:

```powershell
$env:NEXUS_WINDOWS_RELEASE_RUN_ID = '<run-do-windows-release.yml>'
# Só enquanto o harness N→N+1 ainda não produzir a prova automaticamente:
$env:NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER = '<motivo aprovado pelo operador>'
npm run release:publish:windows
```

O run deve ser o workflow protegido, bem-sucedido e no mesmo commit da tag. O
publicador baixa o artifact autenticado, confere seu SHA-256, assinaturas,
timestamp e inventário Squirrel antes de criar drafts e só então publica a
canônica seguida do espelho público.

O runtime de release também é autoridade versionada: use exatamente Node
`22.23.2`, conforme `package.json > nexusRelease.node`. Outro patch de Node 22
falha antes da build.

O runbook canônico, incluindo cadastro interativo da credencial no Keychain,
build, SBOM/audit, verificação do DMG/ZIP e publicação, está em
[`build/notarize.md`](../build/notarize.md).

Não dispare workflows de release antigos, não use `npm version` e não publique pacote
ad-hoc. O worker Windows dedicado é a única fonte aceita para o candidato Windows. A tag local é criada sobre o commit final antes do build, mas só é
enviada pelo alvo de publicação depois dos gates. A release só pode ser criada
quando:

1. typecheck, testes e `npm run release:security` passarem;
2. a missão E2E real passar no artefato candidato;
3. assinatura, Gatekeeper, notarização e *staple* forem verificados;
4. tag, artefatos e evidências de segurança apontarem para o mesmo commit;
5. o manifesto incluir auditoria/SBOM de produção e da toolchain, lockfile,
   versões Node/npm e hashes finais de DMG, ZIP e evidência E2E.

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

## Publicação somente macOS (F-564)

Depois de produzir a candidata local e passar `npm run release:candidate`,
publique com:

```bash
NEXUS_MAC_PUBLISH_RELEASE=1 APPLE_TEAM_ID=35P5XL3JN6 APPLE_KEYCHAIN_PROFILE=nexus-notary npm run release:publish:macos
```

O publicador exige `release-artifacts/candidate-build.json` e o diretório
`release-artifacts/security/`, incluindo `release-candidate-receipt.json` e
`packaged-smoke-report.json`. Revalida HEAD/tag, proveniência da build
(`candidate-build.json`, arquitetura `arm64`), hashes de DMG/ZIP, SBOMs,
auditorias e manifesto de segurança pelos SHA-256 selados pelo gate. Recibo
inexistente, HEAD diferente da tag ou qualquer hash divergente bloqueia a
publicação; este modo nunca dispara outra build nem busca candidato Windows.

A canônica (`Hiper-nexus/nexus-ide`) recebe os nove assets selados: DMG, ZIP,
manifesto de segurança, duas auditorias, dois SBOMs, o relatório de smoke
empacotado e o recibo do candidato. O espelho
(`Hiper-nexus/nexus-ide-releases`) recebe somente DMG e ZIP. A transação
mantém o mesmo lock de publicação usado pelo fluxo composto, prepara/verifica
os dois drafts, publica a canônica, relê o snapshot publicado e só então
publica o espelho — o SHA-256 remoto é conferido nos dois repositórios antes
de cada transição. `--macos` e `--windows` são mutuamente exclusivos na mesma
invocação do CLI.

## Fluxo histórico multiplataforma (somente quando as duas candidatas existem)

O comando legado `npm run release:publish` descreve uma publicação composta.
Ele não é o caminho para desbloquear uma release Windows: use sempre
`npm run release:publish:windows` para publicar o canal Windows de forma
independente. O fluxo composto abaixo permanece documentado apenas para uma
publicação que já tenha candidatas completas dos sistemas envolvidos.

O comando publica duas releases com a mesma tag, em ordem fail-closed:

1. `Hiper-nexus/nexus-ide` recebe DMG, ZIP, manifesto, auditorias,
   SBOMs, evidência E2E e recibo do candidato;
2. para `Hiper-nexus/nexus-ide-releases`, o publicador envia DMG, ZIP, Setup Windows x64, NUPKG completo original e `RELEASES` de uma entrada. Evidências internas e recibos ficam apenas na release canônica.

Em uma publicação nova, ambos os repositórios ficam em *draft*, recebem
upload com `--clobber` e têm nome, tamanho e, quando disponível no draft,
SHA-256 conferidos antes de qualquer release se tornar pública. A release
canônica é publicada e relida primeiro; só então o espelho público pode ser
publicado. No estado publicado, o SHA-256 retornado pelo GitHub é obrigatório
para cada asset. Inventário extra, ausente ou divergente interrompe o fluxo.

Uma tentativa interrompida enquanto ainda há drafts **reutiliza** o recibo
local verde (`release-candidate-receipt.json`) quando HEAD, tag, DMG/ZIP e
evidências E2E ainda batem — sem repetir a missão empacotada. Só roda o gate
completo de novo se o recibo estiver ausente, inválido ou desalinhado. Se a
release canônica já estiver publicada e exata, a retomada também não recompila
nem repete a missão E2E: ela revalida HEAD, tag local e remota, recibo
durável, hashes de DMG/ZIP, manifesto e todos os arquivos de segurança contra a
release canônica publicada, e então conclui o espelho. Se o espelho aparecer
publicado antes da canônica, o comando falha sem tentar “consertar”
silenciosamente. Executar o comando novamente com ambas as releases publicadas
só é aceito quando os dois snapshots são exatamente os esperados.

O candidato Mac continua `arm64`; o candidato Windows é `x64`. Não há promessa de Mac universal/Intel ou Windows ARM sem build/prova separados.

Para checar a credencial local sem expor segredo:

```bash
xcrun notarytool history --keychain-profile "nexus-notary"
```

O workflow anterior foi preservado apenas como histórico em
[`docs/archive/release-actions-workflow.yml`](archive/release-actions-workflow.yml).
Ele está fora de `.github/workflows`, portanto não pode ser executado pelo
GitHub Actions.

Quando `NEXUS_UPDATE_FEED` apontar para um feed HTTPS Nexus válido, ele continua
sendo a fonte preferencial. Sem esse feed, instalações com acesso ao
repositório privado podem usar `gh` autenticado; as demais consultam de forma
anônima o espelho público de artefatos acima. O espelho disponibiliza apenas a
arquitetura realmente construída e provada nesta release.

## Candidato Windows obrigatório

Antes de `npm run release:publish`, obtenha um run concluído com sucesso do workflow
`.github/workflows/windows-release.yml`, no repositório privado canônico e no
mesmo commit da candidata Mac em `main` protegido. Desde 05/10/2026 o build roda
numa máquina Windows do GitHub (`windows-latest`, nova a cada build, ~10 min) e não
depende mais do runner no PC do operador, que só existia para o certificado do
eSigner. O ambiente continua `windows-release-signing` (nome da época da
assinatura). O worker não assina nada.
O input `version` deve corresponder ao package.json, sem prefixo `v`. O worker não
publica releases, e só pode ser iniciado a partir de `main` protegido.

No Mac, selecione o run autenticado:

```bash
NEXUS_WINDOWS_RELEASE_RUN_ID=<id-do-run> npm run release:publish
```

O comando exige workflow, commit, repositório privado, sucesso e artefato exatos;
verifica o SHA-256 do arquivo baixado contra o digest informado pelo GitHub antes
de extrair. O recibo dentro desse arquivo vincula o SHA-256 de cada executável
(Setup, app, Update.exe e ExecutionStub; o do Setup amarrado ao asset), o smoke
e os bytes ao commit/versão. Um JSON local ou o workflow de preview unsigned não
serve como autoridade. Sem worker válido, a publicação Mac também é bloqueada.
As duas plataformas entram na mesma transação de drafts já existente.

O serviço público Windows consulta releases estáveis por ordem de publicação.
Não publique uma versão estável inferior a outra já publicada: o publicador
agora bloqueia esse caso. Preserve o nome original do NUPKG e uma única entrada
no `RELEASES`; somente o Setup recebe nome com `win32-x64`. Não publique deltas
ou múltiplas arquiteturas nesse feed sem validar o suporte.

Os artefatos do worker têm retenção de 90 dias. Depois da expiração, a retomada
falha fechada; não substitua a autoridade por recibo local nem recompile para
sobrescrever bytes já publicados. Resolva a preservação de evidência autenticada
antes de precisar retomar uma release expirada. Releases antigas publicadas só
com Mac não são convertidas por upload avulso: use uma próxima versão conjunta.

O primeiro instalador público precisa conter o atualizador e passar instalação
e atualização real N→N+1, preservando dados. O worker atual prova o smoke do
NUPKG; `installedUpgradeVerified=false` no recibo registra
que essa prova de instalação/upgrade ainda não é produzida por ele. O publicador
**recusa esse recibo**: o candidato pode continuar privado, mas não pode tornar
nenhuma das plataformas pública. O upgrade instalado continua não verificado
nesta entrega.

### Prova de upgrade e concorrência

A prova `installedUpgradeProof` deve vir dentro do mesmo artifact autenticado
do worker e conter schemaVersion 1, status pass, fromVersion estável inferior,
toVersion igual à candidata, commitSha, runId e assetSha256 com os hashes exatos
do Setup, NUPKG e RELEASES. Os checks signedBaselineInstalled,
squirrelUpgradeApplied, targetRestarted e userDataPreserved devem resultar do
teste real. A ausência da prova, alvo errado ou installedUpgradeVerified=false
bloqueia publicação. Um arquivo local editado não substitui essa evidência.
O harness para produzir essa prova ainda não está implementado no coletor.

Enquanto o harness não existe, o operador pode declarar um **waiver** só para
o caso "prova não produzida" (`installedUpgradeVerified=false` e
`installedUpgradeProof` ausente no recibo): `NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER`
com um motivo de uma linha (20–600 caracteres: quem testou o quê, onde e
quando). O waiver nunca cobre uma prova produzida e reprovada, nem uma prova
desvinculada, nem um recibo que se diz verificado sem prova. O publicador
grava `windows-upgrade-proof-waiver.json` (versão, commit, run, motivo, data
e operador) como asset da release canônica, ao lado do recibo, e avisa no
log; o espelho público não recebe o arquivo. Introduzido na 0.76.37, quando a
0.76.32 já tinha saído com o mesmo recibo sem prova.

O comando de produção mantém um lock exclusivo local durante toda a sessão,
compartilhado entre checkouts da conta de release. Outra sessão falha sem
executar publicação; o lock é liberado ao terminar ou falhar normalmente e
nunca é roubado por expiração. Após crash, confira host/PID em owner.json e
remova o lock somente depois de confirmar que a sessão acabou.

As listas estáveis da canônica e do espelho são relidas imediatamente antes
de cada transição draft→publicado. Isso fecha a janela longa de download e
upload. O lock não coordena hosts diferentes; não execute publicadores
independentes em hosts distintos simultaneamente.

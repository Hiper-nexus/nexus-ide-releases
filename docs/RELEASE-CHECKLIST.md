# NexusIDE — Release Checklist

Checklist mínimo para declarar o `.dmg`/`.zip` do NexusIDE release-ready. Inspirado no `qa-release-checklist` do Overclock, mas calibrado para Electron + macOS + multi-agent terminal.

## Pré-build (local)

- [ ] `npm install` limpo passa.
- [ ] Antes da suíte do app, `cd mobile && pnpm install --frozen-lockfile --ignore-scripts` prepara o tsconfig Expo usado pelos testes reais da bridge; o build do mobile continua independente.
- [ ] `npm run rebuild:electron` e `npm run rebuild:node` passam.
- [ ] `npx tsc --noEmit` (ou `npm run typecheck`) passa sem erros.
- [ ] `npm run security:renderer-sinks` passa (0 executable DOM sinks).
- [ ] `npm run test:changed` passa (se houver mudança) ou o suite de regressão de confiança.
- [ ] `npm run make` inicia e chega ao artifact final sem abortar.

## Build e packaging

- [ ] `.dmg` gerado no caminho esperado (`out/make/`).
- [ ] `.zip` (se ativo) descompacta e abre corretamente.
- [ ] Aplicativo é assinado (`codesign -dv --verbose=4 Nexus.app`) e notarizado sem rejeição.
- [ ] Native modules (`node-pty`, `better-sqlite3`, `onnxruntime-node`, etc.) estão no `.app` e não acusam `mach-o` quebrado.
- [ ] CSP e `contextIsolation` não foram removidos/acidentalmente relaxados no build.

## Sanity no app empacotado

- [ ] App abre sem crash de preload/renderer branco.
- [ ] Launcher renderiza; não é tela de título/idle escondendo erro.
- [ ] Workspace abre; terminal responde a input.
- [ ] Missão simples do tipo `ops` (sem workers) consegue iniciar e parar.
- [ ] Missão `standard` com 1–2 workers consegue spawnar, entregar handoff e parar sem crash.
- [ ] Aba Settings/Config abre e lista providers/adapters sem erro de `window.nexus.providers`.
- [ ] Quit (`Cmd+Q`) não deixa processos `node-pty`/`sidecar` órfãos.

## Segurança e config

- [ ] Sem `console.log` sensível em renderer que vaza tokens, chaves ou paths home.
- [ ] Sem API key versionada, asset buildado ou env visível no bundle.
- [ ] Keychain/safeStorage funciona; secrets não vazam em disco plano.
- [ ] `mcp_config.json` gerado aponta para o server embutido, sem URL remota não autorizada.
- [ ] Entitlements/Seatbelt não foram revertidas; `processHome` continua confinado.

## Smoke multi-pane e missão

- [ ] Grid split abre múltiplos panes sem atingir `MAX_LIVE_PANES_HARD` de forma fantasma.
- [ ] Mover um pane entre splits/espaços não re-spawna PTY.
- [ ] Pane de worker morre e o orquestrador consegue dar recovery sem reiniciar a app.
- [ ] Missão bloqueada por `answer-question` mostra o pergunta na UI; `retry-kickoff` não a apaga sem resposta.
- [ ] `STOP` encerra o runtime da missão e o histórico permanece.

## Performance e recursos

- [ ] Heap de renderer e main não cresce sem limite durante 5 min de uso.
- [ ] Sem leaks de pane/session ao abrir/fechar workspaces.
- [ ] Áudio/Voz (Jarvis) não fica com microfone travado após desligar.

## Comandos e variáveis de release

- [ ] Variáveis de publicação (Sentry DSN, update server, API base) apontam para produção.
- [ ] Auto-update está habilitado e aponta para o bucket/feed correto.
- [ ] Debug overlay, devtools, `ELECTRON_ENABLE_LOGGING` e atalhos de teste foram removidos/guardados por flag.
- [ ] Versão no `package.json`, `Info.plist` e título da janela batem.

## Licenças e atribuição

- [ ] `THIRD-PARTY-LICENSES` está presente e cobre Electron, better-sqlite3, @lydell/node-pty, onnxruntime-node, @xterm/xterm, @xyflow/react, uiohook-napi, Silero VAD, piper, whisper.cpp.
- [ ] Nenhum asset de terceiro (fonte, ícone, som, modelo) entrou sem nota de origem/licença.

## Riscos residuais

- [ ] Riscos conhecidos listados no release note.
- [ ] Workarounds documentados para qualquer `precisa-decisao` aberto.

## Formato de evidência de release

Cole no corpo da release ou no canal:

```text
Resultado: pass/fail
Comandos: <make, typecheck, security>
Artifact: <caminho do .dmg>
Assinatura: <codesign -dv --verbose=4 ...>
Smoke: <launcher, terminal, ops, standard 1-2 workers>
Findings fechados: F-XXX, F-YYY, ...
Riscos residuais: ...
```

## Windows x64 (canal independente)

- [ ] Workflow privado `windows-release.yml` concluído para a tag e o commit Windows em `main` protegido. Não exige candidata, assinatura ou notarização macOS.
- [ ] Recibo `schemaVersion` 2 com SHA-256 de Setup, aplicativo, Squirrel.exe (Update.exe instalado) e ExecutionStub. Build local assinado pelo YubiKey (`NEXUS_WINDOWS_YUBIKEY_SIGNING=1`, `docs/windows-signing/YUBIKEY.md`): `signing: yubikey`, os quatro com assinatura e carimbo do certificado fixado em `build/windows-signing-identity.json`, e `Get-AuthenticodeSignature` = `Valid` HIPERSEND no Setup. Sem o token (worker do GitHub, ou enquanto o thumbprint estiver `null`): `signing: none`. O eSigner saiu em 05/10/2026 e não volta.
- [ ] Instalação limpa pelo Setup e atualização N→N+1 funcionam sem gh/login; dados e terminal preservados.
- [ ] SHA-256 do artifact GitHub validado; recibo e três assets Windows entram na transação de drafts do canal Windows (`npm run release:publish:windows`).
- [ ] NUPKG mantém nome original e RELEASES contém uma única entrada completa; Setup identifica win32-x64.
- [ ] Nenhuma versão Windows estável maior já foi publicada. Uma release somente macOS/Linux não avança nem bloqueia o canal Windows.

O workflow não substitui a prova de upgrade instalado; o recibo distingue esse
limite explicitamente. Nunca marque a release pronta apenas por um build unsigned.

## Linux x64 (canal independente)

- [ ] Workflow `linux-release.yml` concluído para a tag anotada e o commit em `main` protegido, no runner hospedado `ubuntu-22.04`. Não exige candidata macOS nem worker Windows.
- [ ] O job produziu exatamente `nexus-ide_<v>_amd64.deb`, `nexus-ide-<v>-1.x86_64.rpm` e `NexusIDE-linux-x64-<v>.zip` (um de cada), mais `linux-release-receipt.json` v2 no artifact `linux-x64-release`. Receipts históricos v1 aceitam somente DEB/RPM.
- [ ] O smoke empacotado rodou sob `xvfb-run`; o DEB foi instalado e aberto no próprio runner (`apt-get install`), com `dpkg-query` confirmando a versão e `rpm -qpR` mostrando a dependência `bubblewrap`. O ZIP foi validado contra path/symlink escape, extraído e aberto pelo mesmo harness.
- [ ] `npm run release:publish:linux -- --version <v> --run <id>` revalidou run, recibo (commit/tagObject), bytes e SHA-256 antes de anexar deb, rpm, ZIP e `SHA256SUMS-linux-x64.txt` na canônica e depois no espelho — nunca `--clobber`, nunca delete.
- [ ] `bubblewrap` está instalado na máquina de validação (dependência de runtime declarada nos dois pacotes).
- [ ] `SHA256SUMS-linux-x64.txt.sig` foi assinado com a chave Ed25519 autorizada e publicado nos dois repositórios; assinatura e ZIP listado foram conferidos. A chave privada nunca entra no repositório, container ou log. Sem a assinatura, a instalação portátil não consegue atualizar.
- [ ] O upgrade portátil (`linux-self`, instalação via `install.sh`) foi validado. Instalações DEB/RPM em diretórios do sistema permanecem manuais; não anunciar auto-update para elas.
- [ ] Nenhuma versão Linux estável maior já foi publicada. Uma release somente macOS/Windows não avança nem bloqueia o canal Linux.

- [ ] O preview de PR/main registrou o SHA exato e os resultados de build/smokes; `linux-x64-preview` e `linux-browser-smoke` são evidência de CI, não candidatas publicáveis.
- [ ] Compatibilidade Omarchy/Hyprland, se anunciada, tem prova na máquina alvo. Xvfb com sandbox desabilitada exclusivamente no harness não comprova essa sessão nem Bubblewrap real.

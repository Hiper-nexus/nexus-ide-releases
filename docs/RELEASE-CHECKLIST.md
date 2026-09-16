# NexusIDE — Release Checklist

Checklist mínimo para declarar o `.dmg`/`.zip` do NexusIDE release-ready. Inspirado no `qa-release-checklist` do Overclock, mas calibrado para Electron + macOS + multi-agent terminal.

## Pré-build (local)

- [ ] `npm install` limpo passa.
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
- [ ] Canvas arrasta pane sem re-spawnar PTY.
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
- [ ] Setup, aplicativo, Squirrel.exe (Update.exe instalado) e ExecutionStub têm assinatura HIPERSEND válida e timestamp.
- [ ] Instalação limpa pelo Setup e atualização assinada N→N+1 funcionam sem gh/login; dados e terminal preservados.
- [ ] SHA-256 do artifact GitHub validado; recibo e três assets Windows entram na transação de drafts do canal Windows (`npm run release:publish:windows`).
- [ ] NUPKG mantém nome original e RELEASES contém uma única entrada completa; Setup identifica win32-x64.
- [ ] Nenhuma versão Windows estável maior já foi publicada. Uma release somente macOS/Linux não avança nem bloqueia o canal Windows.
- [ ] Saldo/validade CKA suficientes para o inventário real: dezenas de arquivos podem consumir várias assinaturas por build.

O workflow não substitui a prova de upgrade instalado; o recibo distingue esse
limite explicitamente. Nunca marque a release pronta apenas por um build unsigned.

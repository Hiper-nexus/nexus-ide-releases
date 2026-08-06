# F1 — Arquitetura & entry points (boot do zero ao pronto)

> Engenharia reversa read-only. Toda afirmação cita `arquivo:linha` verificado no
> working tree em 2026-08-06 (branch `main`, versão `0.27.0` — `package.json:4`).

## 0. Resumo (10 linhas)

1. O entry do Electron **não** é um arquivo `.ts` — é o bundle `.vite/build/main.js` (`package.json:6`).
2. Esse bundle é gerado de `src/main/main-bootstrap.ts` pelo Electron Forge (`forge.config.ts:395`).
3. `main-bootstrap.ts` é deliberadamente minúsculo (12 linhas): fixa a activation policy do macOS **antes** de tocar o grafo pesado, e só então faz `import('./main')` dinâmico.
4. `src/main/main.ts` (1139 linhas) roda código **no top level** antes de `app.whenReady` — switches de Chromium, override de userData, fallback de GPU, CDP opt-in, registro do scheme `nexus-app`.
5. O boot é **fail-closed em três portões**: protocolo do renderer, CSP e bootstrap de IPC. Qualquer um falhando ⇒ `app.quit()` sem renderer parcial.
6. A janela nativa nasce **antes** de qualquer serviço (`main.ts:734`) com o renderer **deferido** — a navegação real só começa depois que `bootstrap()` registrou todo o IPC (`main.ts:770-771`).
7. O renderer carrega de `nexus-app://bundle/index.html` no pacote e do dev server do Vite em dev (`window.ts:246-247`).
8. A fronteira preload↔renderer é **um único** `contextBridge.exposeInMainWorld('nexus', api)` (`preload.ts:1586`) com 42 namespaces; `ipcRenderer` cru nunca é exposto.
9. O PTY roda num `utilityProcess` separado, forkado **preguiçosamente** no primeiro spawn (`pty-host-client.ts:49-51`), não no boot.
10. "Pronto" é definido pelo React, não pelo Chromium: `did-finish-load` não conta — só o sinal `renderer:mounted` (ou o polling de `#root`) mostra a janela.

---

## 1. Trace ponta-a-ponta

### Fase A — antes de `app.ready` (top level do main)

| # | Passo | Fonte |
|---|---|---|
| A1 | Electron lê o campo `main` do `package.json` e carrega `.vite/build/main.js` | `package.json:6` |
| A2 | Esse arquivo é o bundle de `src/main/main-bootstrap.ts` (entry `target: 'main'` do VitePlugin) | `forge.config.ts:395` |
| A3 | O nome de saída `main.js` é forçado no Rollup — o Forge/Packager exige esse nome exato | `vite.main.config.ts:33` |
| A4 | `ensureRegularMacOSActivation()` roda **síncrono, primeiro**. Comentário no código explica: carregar o runtime antes disso fazia o macOS classificar o NexusIDE como `UIElement` (app sem Dock) | `main-bootstrap.ts:7` (impl. `macos-activation-policy.ts:15-18`, `app.setActivationPolicy('regular')`) |
| A5 | `void import('./main')` — import **dinâmico**; se o runtime falhar ao carregar, loga e `app.quit()` | `main-bootstrap.ts:9-12` |
| A6 | `src/main/main.ts` reimporta a política de ativação como side-effect | `main.ts:1` |
| A7 | `registerRendererProtocolScheme(protocol)` — registra `nexus-app` como scheme privilegiado (`standard`, `secure`, `supportFetchAPI`, `codeCache`). **Tem que rodar antes do `ready`** | `main.ts:37` → `renderer-protocol.ts:79-90` |
| A8 | Switches de Chromium: `disable-background-timer-throttling` + `disable-features=IntensiveWakeUpThrottling,TimerThrottlingForBackgroundTabs`. Motivo documentado: com o app em background o message pump adiava a fase de timers e o spawn/merge de workers congelava | `main.ts:43-47` |
| A9 | Override de `userData` via `NEXUS_USER_DATA_DIR` — só honrado em dev/teste explícito ou no E2E de missão real; launches empacotados normais **nunca** obedecem | `main.ts:52-61` |
| A10 | Fallback de GPU: lê marker de crash anterior; se presente, `disableHardwareAcceleration()` + `--disable-gpu` | `main.ts:65-82` (`crash-reporting/gpu-fallback-marker.ts`) |
| A11 | CDP opt-in: `NEXUS_REMOTE_DEBUG` liga `remote-debugging-port`. **Nunca** em build empacotado (`!app.isPackaged` no guard) | `main.ts:91-104` |
| A12 | `initSmokeTest()` | `main.ts:678` |
| A13 | `wireDeepLinks()` registra `nexus://` e pega o **single-instance lock**. Se outra instância detém o lock, `app.quit()` — a instância viva recebe o link | `main.ts:682-683` → `deep-link.ts:172-188` (`app.requestSingleInstanceLock()` em `:186`) |

### Fase B — `app.whenReady()`

| # | Passo | Fonte |
|---|---|---|
| B1 | `app.whenReady().then(async () => {...})` | `main.ts:685` |
| B2 | Aguarda a inicialização do harness de E2E de missão real (se ativo) — fence para o evento `mounted` não ultrapassar os observadores de IPC | `main.ts:686` (setup em `:669-677`) |
| B3 | **darwin:** varredura de supervisores PTY órfãos via `/bin/ps`. Justificativa no código: supervisores rodam *disclaimed* (ppid 1 mesmo saudáveis), então no boot — com lock de instância única — nenhum supervisor deste install pode ter dono | `main.ts:692-708` → `app-quit-guarantee.ts` (`sweepOrphanPtySupervisors`) |
| B4 | **Portão 1 (fail-closed):** `installRendererProtocol(protocol, path.join(__dirname, '../renderer/' + MAIN_WINDOW_VITE_NAME))`. Falhou ⇒ `dialog.showErrorBox` + `app.quit()` + `return` | `main.ts:713-730`; handler em `renderer-protocol.ts:204-212` |
| B5 | `createMainWindow({ deferRendererLoad: true })` — janela nativa **antes** de qualquer serviço. Comentário: APIs do macOS (Keychain) podem bloquear a main thread; o item de Dock precisa existir antes | `main.ts:734` |
| B6 | Retornou `null` ⇒ `app.quit()` + `return` (não segue o bootstrap, que criaria janelas auxiliares) | `main.ts:735-741` |
| B7 | `startMacOSDockWatchdog()` | `main.ts:742` |
| B8 | `powerSaveBlocker.start('prevent-app-suspension')` — App Nap do macOS suspendia todos os timers do main com a janela fora de foco | `main.ts:749` |
| B9 | `getAgentAwakeService()` + `registerAgentHookIpc()` | `main.ts:752-753` |
| B10 | **Portão 2:** `await resolveUserPath()` — resolve o PATH do login shell de forma assíncrona. Launches por Finder/dmg herdam PATH mínimo; fazer isso síncrono congelava o event loop | `main.ts:769` |
| B11 | `bootstrap()` — todo o registro de IPC e serviços (ver §1.1) | `main.ts:770` (corpo em `:395-663`) |
| B12 | `startMainWindowRenderer(mainWindow)` — libera a navegação deferida. Retorna `false` ⇒ `throw` | `main.ts:771-775` |
| B13 | Qualquer erro em B10–B12 ⇒ `showErrorBox` + `app.quit()`. **Nenhum renderer parcial é exposto** | `main.ts:776-789` |
| B14 | Re-arma o dock watchdog (o grafo de janelas auxiliares já assentou) | `main.ts:795-796` |
| B15 | Hooks gerenciados de agente: registra installers, sobe o HTTP server de hooks, resolve consentimento e aplica idempotentemente (`installManagedAgentHooks` / `removeManagedAgentHooks`) | `main.ts:802-835` |
| B16 | `app.on('child-process-gone')` → classificação + marker de GPU | `main.ts:838-854` |
| B17 | `askForMediaAccess('microphone')` em darwin — **nunca bloqueia** a abertura da janela | `main.ts:875-877` |

#### 1.1 O que `bootstrap()` faz (ordem importa)

`main.ts:395-663`. A ordem é deliberada e comentada no código:

| Ordem | Chamada | Fonte | Por que nessa posição |
|---|---|---|---|
| 1 | `configureFeatureFlagRegistry` | `main.ts:398-400` | Antes de qualquer `getFeatureFlagRegistry()` no resto do bootstrap |
| 2 | `registerSettingsIpc()` | `main.ts:412` | Carrega `~/.nexus/settings.json` antes de qualquer runtime ler flags de orquestração |
| 3 | `initAdapterRegistry()` / `initializeProviderConfigStore()` | `main.ts:413-414` | — |
| 4 | `new ProjectRuntimeManager(...)` | `main.ts:435-438` | Base de `userData/project-runtime`; injetado em ~8 subsistemas logo abaixo |
| 5 | `configureWorktreePtySweep` | `main.ts:462-465` | Injetado (não importado) para **não fechar ciclo ESM** — `pty-manager` já importa de `runtime/` |
| 6 | `registerPtyIpc()` | `main.ts:510` | Aqui é onde o host PTY é injetado (ver §1.3) |
| 7 | `registerVoiceIpc` … `registerEvalRankingIpc` | `main.ts:542-561` | IPC secundário; a janela **já está aberta** (comentário em `:544-546`) |
| 8 | `initQuotaService` | `main.ts:585-616` | Sondas multi-candidato de credencial (vault → launcher → env → CLI) |
| 9 | `syncLicenseOnBoot()` | `main.ts:626` | Pulado em teste automatizado — pode bloquear em `SecItemCopyMatching` |
| 10 | `initDesktopPet()` | `main.ts:636` | Depois da janela principal |
| 11 | `initOrchestration()` (async, não-await) | `main.ts:641-646` | Sobe um servidor MCP em porta localhost; a janela já está aberta e a orquestração "se acopla quando pronta" |
| 12 | `startCronLoop()` / `configureGoalDriver` | `main.ts:648-655` | Loops time-driven e goal-driven |
| 13 | `consumeLaunchDeepLink()` + `initAutoUpdater` | `main.ts:658-661` | — |

> Instrumentação: `traceBootstrap(phase)` só imprime com `NEXUS_BOOT_TRACE=1` (`main.ts:360-364`); pontos em `:541`, `:543`, `:562`, `:566`, `:617`, `:633`, `:662`.

### Fase C — criação da janela (`window.ts`)

| # | Passo | Fonte |
|---|---|---|
| C1 | `rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? RENDERER_PROTOCOL_ENTRY_URL` — dev server em dev, `nexus-app://bundle/index.html` no pacote | `window.ts:246-247`; constante em `renderer-protocol.ts:7-8` |
| C2 | `ensureMacDockPresence()` antes da primeira janela nativa | `window.ts:252` |
| C3 | **Portão 3 (fail-closed):** `registerCsp(devServerUrl)`. Erro ⇒ `showErrorBox` + `return null` — sem CSP não carrega renderer | `window.ts:257-271` |
| C4 | `new BrowserWindow({...})` com `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, `show: false` | `window.ts:273-299` |
| C5 | Preload apontado para `path.join(__dirname, 'preload.js')` — irmão do `main.js` no `.vite/build/` | `window.ts:289` |
| C6 | `bindTrustedMainWindow(win, rendererUrl)` — amarra a autoridade de IPC a **este** WebContents | `window.ts:305` → `security/trusted-ipc.ts:58-66` |
| C7 | Navegação e novas janelas bloqueadas: `setWindowOpenHandler(() => ({action:'deny'}))` + `will-navigate` → `preventDefault()` | `window.ts:317-318` |
| C8 | `deferredRendererStarts.set(win, startRenderer)`; com `deferRendererLoad: true` **não** chama `startMainWindowRenderer` ainda | `window.ts:758-761` |
| C9 | Depois (de `main.ts:771`): `startMainWindowRenderer(win)` → `startRenderer()` → `load()` → `win.loadURL(rendererUrl)` | `window.ts:205-211`, `:749-757`, `:567-585` |

### Fase D — renderer e o sinal de "pronto"

| # | Passo | Fonte |
|---|---|---|
| D1 | Chromium carrega `index.html` e o bundle do renderer | entrada declarada em `vite.renderer.config.ts:31-34` |
| D2 | `installRestoredAgentsGate()` roda **antes** do React montar | `src/renderer/main.tsx:9` |
| D3 | `createRoot(container).render(<ErrorBoundary><App/></ErrorBoundary>)`. **Sem `StrictMode`** — o double-mount de dev spawnaria/mataria PTYs duas vezes por pane | `src/renderer/main.tsx:11`, `:19-23` |
| D4 | `ErrorBoundary.componentDidMount()` → `window.nexus.app.signalMounted({ok:true})` (ou `{ok:false,error}`) | `src/renderer/components/ErrorBoundary.tsx:36-42` |
| D5 | Preload traduz para `ipcRenderer.send(WINDOW_CHANNELS.mounted, report)` | `preload.ts:806` |
| D6 | Canal literal: `'renderer:mounted'` | `src/shared/channels.ts:189` |
| D7 | Main escuta com escopo neste WebContents: `if (event.sender === wc) commitRendererBoot()` | `window.ts:488-493` |
| D8 | `commitRendererBoot()` → `showNativeWindow()` — **só aqui a janela aparece** | `window.ts:476-483`, `:399-428` |

### Fase E — PTY host (lazy, fora do boot)

| # | Passo | Fonte |
|---|---|---|
| E1 | `registerPtyIpc()` chama `setPtyHost(createRealPtyHost())` | `pty-ipc.ts:415` |
| E2 | `createRealPtyHost()` cria a **ponte**, não o processo | `pty-host-client.ts:58-67` |
| E3 | `transport.ensure()` só forka se ainda não há filho — ou seja, **no primeiro spawn**, não no boot | `pty-host-client.ts:48-55` |
| E4 | `utilityProcess.fork(hostEntryPath(), [], { serviceName: 'nexus-pty-host' })` | `pty-host-client.ts:34-36` |
| E5 | `hostEntryPath()` = `path.join(__dirname, 'pty-host-entry.js')` — irmão do `main.js`, **dentro do asar** no pacote | `pty-host-client.ts:29-31` |
| E6 | O filho é bundle de `src/main/pty/pty-host-entry.ts` (segundo entry `target: 'main'`) | `forge.config.ts:398` |
| E7 | O host fala com o main **exclusivamente** por `process.parentPort` e não decide política nenhuma — "dumb executor" | `pty-host-entry.ts:8-11`, `:33-39` |
| E8 | Morte do filho ⇒ `bridge.handleHostDown()` e re-fork no próximo spawn. O handler ignora filhos já substituídos (`if (child !== c) return`) | `pty-host-client.ts:39-45` |

---

## 2. Inventário

### 2.1 Entry points de build (`forge.config.ts` → VitePlugin)

| Entry (fonte) | Config Vite | Target | Saída | Fonte |
|---|---|---|---|---|
| `src/main/main-bootstrap.ts` | `vite.main.config.ts` | `main` | `.vite/build/main.js` | `forge.config.ts:395` + `vite.main.config.ts:33` |
| `src/main/pty/pty-host-entry.ts` | `vite.pty-host.config.ts` | `main` | `.vite/build/pty-host-entry.js` | `forge.config.ts:398` |
| `src/preload/preload.ts` | `vite.preload.config.ts` | `preload` | `.vite/build/preload.js` | `forge.config.ts:399` |
| `src/preload/browser-preload.ts` | `vite.preload.config.ts` | `preload` | `.vite/build/browser-preload.js` | `forge.config.ts:403` |
| `src/preload/pet-preload.ts` | `vite.preload.config.ts` | `preload` | `.vite/build/pet-preload.js` | `forge.config.ts:406` |
| renderer `main_window` | `vite.renderer.config.ts` | renderer | `.vite/renderer/main_window/` | `forge.config.ts:408` |

### 2.2 O que cada config Vite empacota

| Config | Decisão-chave | Fonte |
|---|---|---|
| `vite.main.config.ts` | `entryFileNames: 'main.js'` (nome exigido pelo Packager) | `:33` |
| | Externals: `@lydell/node-pty`, `better-sqlite3`, `uiohook-napi`, `onnxruntime-node`, `@ennuicastr/webrtcaec3.js`, `ssh2`, `cpu-features` — natives resolvidos de `node_modules` (dev) / `app.asar.unpacked` (prod) | `:39-51` |
| | `define` assa `NEXUS_LICENSE_PUBKEY` no bundle: app empacotado não vê env do shell. Sem a env ⇒ `''` ⇒ fail-closed (nenhuma licença aceita) | `:24-28` |
| | Alias de `tslib` para `tslib.es6.mjs` — o exports map resolvia para um CJS cujo `.default` o rolldown deixava `undefined`, quebrando o app empacotado no startup | `:60-62` |
| `vite.preload.config.ts` | Só `electron` como external; preload roda em contexto sandboxed | `:16` |
| `vite.pty-host.config.ts` | Só `@lydell/node-pty` external — o `.node` nunca entra no grafo do Rollup | `:19` |
| `vite.renderer.config.ts` | `assetsInlineLimit: 0` — inlinar `?url` como `data:` faz a CSP de produção rejeitar `addModule()` do AudioWorklet (degrada mic para o fallback lento) | `:26` |
| | Duas entradas HTML: `index.html` e `pet.html` — duas janelas, um bundle | `:31-34` |
| **todos os 4** | `server.watch.ignored` inclui `**/.dev-user-data/**` — worktrees de worker são checkouts completos dentro do watch root; sem isso o dev server entrava em reload storm e a janela ficava preta | `vite.main:14-16`, `vite.preload:10-12`, `vite.pty-host:13-15`, `vite.renderer:9-20` |

### 2.3 Empacotamento e hardening (`forge.config.ts`)

| Componente | Fonte | Responsabilidade |
|---|---|---|
| `FusesPlugin` | `:412-421` | `RunAsNode:false`, `EnableNodeOptionsEnvironmentVariable:false`, `EnableNodeCliInspectArguments:false`, `EnableEmbeddedAsarIntegrityValidation:true`, `OnlyLoadAppFromAsar:true`, `GrantFileProtocolExtraPrivileges:false` |
| `asar.unpack` | `:281-288` | `*.node`, `*.dylib`, `*.so*`, `*.wasm`, tesseract. Usa o `asar.unpack` do packager **em vez** do `AutoUnpackNativesPlugin` — o plugin repacka o asar **depois** do hash de integridade, o que trava a fuse num hang silencioso |
| `ignore: shouldPackageFile` | `:292` (impl. `:69-86`) | Allowlist explícita: `package.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `third_party/licenses/`, `.vite/`, `node_modules/` |
| `extendInfo` | `:298-344` | `LSUIElement: false` (classificação de launch explícita), ATS com `NSAllowsArbitraryLoads:false` + `NSAllowsLocalNetworking:true`, scheme `nexus://`, tipos de documento |
| `osxSign` / `osxNotarize` | `:359`, `:361-367` | Assinatura sempre roda (ad-hoc `-` sem credencial); notarização só via publish local com keychain profile |
| hook `postPackage` | `:216-247` | Valida o modelo wake PT-BR por checksum (`:34-57`) e **re-assina** a hierarquia após as fuses mexerem no executável |
| hook `postMake` | `:248-249` | Notariza — exige **exatamente um** DMG (`:142-144`) |

### 2.4 Fronteira de IPC

| Superfície | Fonte | O que expõe |
|---|---|---|
| `window.nexus` | `preload.ts:1586` | **42 namespaces** (§2.5). Único bridge da janela principal |
| `window.nexusPet` | `pet-preload.ts:51` | Preload mínimo do pet (prefs/eventos/drag) — a janela do pet **nunca** vê o contrato completo (`forge.config.ts:404-405`) |
| `browser-preload.ts` | `forge.config.ts:400-402` | **Não expõe API de página nenhuma**; só aceita o contrato fechado de automação vindo do main |
| Gate de remetente | `security/trusted-ipc.ts:58-66`, `:70+` | `bindTrustedMainWindow` registra o WebContents; `isLiveTrustedMainWindowSender` valida protocol+host e rejeita credenciais na URL. Janelas auxiliares **nunca** são registradas |
| Uso do gate | `window.ts:124-126`, `:149-151`, `:162-164` | `openExternal`, `authLogin`, `openLegalNotices` retornam `'renderer não autorizado'` para remetente não confiável |
| `openExternal` | `window.ts:127-139` | Limite de 2048 chars; **só** `https:` |

### 2.5 Os 42 namespaces de `window.nexus`

`pet`(759) · `app`(805) · `pty`(815) · `browser`(843) · `devServer`(897) · `design`(900) · `layout`(909) · `adapters`(917) · `onboarding`(925) · `update`(930) · `voice`(938) · `orch`(1002) · `remote`(1205) · `settings`(1225) · `workspace`(1239) · `orientation`(1248) · `contextDrafts`(1256) · `providers`(1264) · `files`(1279) · `terminalBlock`(1299) · `searchMixer`(1304) · `product`(1308) · `discovery`(1350) · `memory`(1354) · `model`(1359) · `integrations`(1363) · `accounts`(1364) · `cost`(1382) · `usage`(1389) · `quota`(1394) · `gamification`(1402) · `perf`(1417) · `mcp`(1420) · `ops`(1427) · `ranking`(1431) · `media`(1434) · `notes`(1449) · `pipes`(1457) · `billing`(1464) · `team`(1470) · `vision`(1479) · `platform`(1499)

(números = linha em `src/preload/preload.ts`; objeto `api` começa em `:758`)

### 2.6 CSP

| Ambiente | Política | Fonte |
|---|---|---|
| Produção | `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval' blob:`; `connect-src 'self'`; `object-src 'none'`; `frame-ancestors 'none'` | `window.ts:105-117` |
| Dev | Igual **+** `'unsafe-inline'` no `script-src` e a origin+ws do dev server no `script-src`/`connect-src` — o preâmbulo inline do Fast Refresh exige | `window.ts:84-102` |
| Entrega | Header de resposta em `session.defaultSession.webRequest.onHeadersReceived` (não `<meta>` — meta não consegue liberar o socket de HMR) | `window.ts:219-235` |
| `wasm-unsafe-eval` + `worker-src blob:` | Porcupine (wake word) roda WASM em Worker/AudioWorklet a partir de blob — código **nosso**, sem origem remota | `window.ts:79-82` |

### 2.7 Handler do protocolo `nexus-app://`

`renderer-protocol.ts:98-201`. Trata a URL como **não confiável** mesmo vindo do próprio renderer:

- Só `GET`/`HEAD` (`:109-111`); rejeita origin/host divergente e credenciais na URL (`:120-127`)
- Path máximo 4096 (`:129-131`); rejeita `\0` e `\` (`:140-142`); rejeita segmentos `.`/`..` (`:146-148`)
- Checagem **léxica** (`isInside`, `:150-153`) **e** de symlink via `realpath` (`:155-170`) — escape por link simbólico é barrado
- `cache-control: immutable` só para assets com hash no nome (`IMMUTABLE_ASSET_RE`, `:11`, `:179-181`); resto é `no-store`

---

## 3. Não-óbvio / armadilhas

1. **`main.js` na raiz do repositório é uma armadilha.** Tem 274 bytes numa única linha sem newline final (por isso `wc -l` reporta `0` e parece vazio). É um bundle rolldown **minificado** — `require('./rolldown-runtime-D_FWMvbo.js')`, `require('./main-B-7tm2vZ.js')`. Não é fonte e **não é o entry**. O entry real é `.vite/build/main.js` (`package.json:6`), gerado de `src/main/main-bootstrap.ts` (`forge.config.ts:395`).

   Os dois arquivos **não são idênticos**: `cmp main.js .vite/build/main.js` diverge no **char 86** — o da raiz referencia o chunk `main-B-7tm2vZ.js`, o de build referencia `main-DU3Ubku5.js`. Mesmo tamanho (274 B), datas diferentes (raiz 15/jul 12:54; build 04/ago 12:43). É **sobra de um build anterior**, não uma cópia do atual.

   Ambos são ignorados **por design**, em duas regras distintas: `.gitignore:77` (`.vite/`) e `.gitignore:82` (`/main.js` — a saída na raiz é esperada). Ou seja, o arquivo na raiz não é descuido de alguém: o build já produziu ali antes, e a regra continua. Mas hoje ele é lixo, e é o primeiro lugar onde quem procura o entry vai olhar.

2. **A ordem de `main-bootstrap.ts` é um bugfix, não estilo.** O comentário em `main-bootstrap.ts:4-6` diz explicitamente: carregar o runtime (que importa módulos nativos e um grafo grande do Electron) antes da chamada síncrona de `ensureRegularMacOSActivation()` é o que fazia o macOS classificar o app como `UIElement` — sem ícone no Dock. Mover aquele import para cima quebra o app de forma difícil de diagnosticar.

3. **A janela nasce vazia de propósito.** `createMainWindow({ deferRendererLoad: true })` (`main.ts:734`) constrói a `BrowserWindow` e a posse do Dock **antes** de qualquer serviço, mas mantém o renderer em `about:blank` até `bootstrap()` registrar todo o IPC. O comentário em `main.ts:756-759` explica o motivo: carregar React antes disso fazia o primeiro launch correr por respostas "No handler registered" e podia deixar stores presos no estado de fallback até um reload.

4. **`did-finish-load` não significa "pronto".** O watchdog é de **duas fases** (`window.ts:599-610`): fase 1 cobre load pendurado; fase 2 espera prova de mount. Um deadline único de 4s recarregava a janela **enquanto** o React ainda carregava — era o bug das "várias piscadas" na tela inicial. Hoje há três caminhos de prova: o IPC `renderer:mounted`, o polling de `#root` a cada 2s (`window.ts:668-673`) e o deadline de mount que vive no Main (`RendererMountWatchdog`) — este último funciona mesmo se um loop síncrono no React congelar o renderer inteiro.

5. **`about:blank` é explicitamente cercado.** Vários handlers começam com `if (!rendererStartAuthorized) return` (`window.ts:587`, `:657`, `:733`). Sem isso, o `about:blank` implícito da `BrowserWindow` consumiria a prova de mount/Dock e armaria um reload que furaria a fronteira do load deferido.

6. **`webContents` é capturado antecipadamente, sempre.** Em `main.ts:956` e `window.ts:322` o código guarda `const wc = win.webContents` **antes** de registrar o handler de `closed`/`destroyed`. O comentário explica: dentro do `'closed'` o getter já lança `"Object has been destroyed"` e, como exceção não capturada dentro do emit, **derruba o processo main inteiro**.

7. **A janela do pet não é uma janela de app.** `isPetWindow(win)` decide se o WebContents vira listener de orquestração (`main.ts:960-962`). Registrar o pet fazia ele **substituir** a janela principal como alvo de spawn de pane — todo reviewer delegado sumia num timeout de 90s. O mesmo check aparece no `activate` (`main.ts:927-929`): com o pet vivo, clicar no Dock ainda precisa reabrir a janela principal.

8. **`AutoUnpackNativesPlugin` é proibido.** `forge.config.ts:277-280` documenta: o plugin repacka o asar **depois** que o hash `ElectronAsarIntegrity` já foi computado no `Info.plist`, o que faz a fuse de integridade travar num hang silencioso. Por isso se usa o `asar.unpack` do próprio packager.

9. **`shouldPackageFile` é allowlist, e precisa ser.** O ignore padrão do `plugin-vite` empacota **só** os bundles `.vite`, dropando silenciosamente os externals de runtime (`@lydell/node-pty`, `better-sqlite3`, …) — que são justamente os módulos marcados como external em `vite.main.config.ts:39-51`. `forge.config.ts:289-292` explica a troca.

10. **A chave pública de licença é assada em build time.** `vite.main.config.ts:24-28`: um `.dmg` não recebe env do shell em runtime. Buildar sem `NEXUS_LICENSE_PUBKEY` exportada produz `''` ⇒ `licensePublicKey()` retorna `null` ⇒ **nenhuma licença é aceita**. É fail-closed por design, mas é silencioso — um build "bem-sucedido" pode não validar licença nenhuma.

11. **O PTY host não sobe no boot.** `pty-ipc.ts:415` só injeta a ponte; o `utilityProcess` real é forkado na primeira sessão (`pty-host-client.ts:49-51`). Procurar o processo `nexus-pty-host` logo após o launch e não achar não é bug.

12. **O quit tem um teto que não se pode limpar.** `createUnclearableQuitCeiling` (`main.ts:903-907`, 45s em `:892`) é armado **antes** do primeiro `await` do shutdown e não tem API de clear. O comentário em `main.ts:1111-1115` nomeia o defeito-raiz que motivou isso: um `.catch` limpava o backstop exatamente quando ele era necessário. A única revogação é a escolha explícita do operador de manter o app aberto (`main.ts:922`).

13. **`npm start` não é `electron-forge start`.** `package.json:19` aponta para `scripts/dev-start.mjs`, que primeiro garante uma identidade TCC de dev (`dev-start.mjs:29`), isola o `userData` (`:37`), roda `rebuild:electron` para o ABI do Electron (`:112-113`), chama `electron-forge start` (`:115-116`) e no fim **restaura o ABI do Node** (`:118`). Rodar `electron-forge start` direto (`package.json:42`, `start:forge`) pula tudo isso.

14. **Sem `StrictMode`, e isso é intencional.** `src/renderer/main.tsx:11`: o double-mount de dev spawnaria e mataria PTYs duas vezes por pane.

---

## 4. Essencial vs incidental

### Essencial (remover quebra ou torna o app inseguro)

| Item | Fonte | Por quê |
|---|---|---|
| `ensureRegularMacOSActivation()` antes do import do runtime | `main-bootstrap.ts:7` | Sem isso o app vira `UIElement` no macOS — sem Dock |
| `registerRendererProtocolScheme` antes do `ready` | `main.ts:37` | Chromium precisa conhecer o scheme antes; assets relativos e secure-context dependem disso |
| Os 3 portões fail-closed (protocolo, CSP, bootstrap) | `main.ts:713-730`, `window.ts:257-271`, `main.ts:776-789` | Cada um garante que **nenhum renderer parcial ou desprotegido** é exposto |
| `contextIsolation`/`nodeIntegration`/`sandbox` + fuses | `window.ts:290-297`, `forge.config.ts:412-421` | Baseline de segurança do renderer |
| `bindTrustedMainWindow` + `isLiveTrustedMainWindowSender` | `security/trusted-ipc.ts:58-66` | Impede janela auxiliar de exercer autoridade da principal |
| Validação de path no handler `nexus-app://` | `renderer-protocol.ts:140-170` | Barra path traversal léxico **e** por symlink |
| Externals nativos nos configs Vite | `vite.main.config.ts:39-51` | Bundlar `.node` quebra os binários |
| `asar.unpack` do packager (não o plugin) | `forge.config.ts:277-288` | Evita o hang silencioso da fuse de integridade |
| Load deferido do renderer | `main.ts:734` + `:771` | Ordena "janela visível" antes de "IPC pronto" sem expor UI meio-morta |
| Watchdog de mount em duas fases | `window.ts:599-651` | Sem ele, uma janela preta é permanente |
| PTY em `utilityProcess` isolado | `pty-host-client.ts:34-36` | Segfault do addon nativo não derruba main/UI |

### Incidental (existe por história ou conveniência; poderia mudar)

| Item | Fonte | Observação |
|---|---|---|
| `main.js` na raiz | (untracked) | Puro lixo de build. Apagar não afeta nada |
| `traceBootstrap` | `main.ts:360-364` | Instrumentação opt-in por env |
| CDP via `NEXUS_REMOTE_DEBUG` | `main.ts:91-104` | Ferramenta de dev; já proibida em pacote |
| Espelho de log de console do renderer | `window.ts:512-525` | Só dev; filtro por tags `[wake|voice|orch|diag]` |
| Diagnóstico de `#root` vazio | `window.ts:683-723` | Só dev; captura overlay do Vite e recursos 4xx |
| Tela de recuperação injetada | `window.ts:51-67` | UX de último recurso, não caminho normal |
| Housekeeping do Squirrel/Windows | `main.ts:384-393` | No-op fora do Windows |
| Gamificação, pet, auto-updater | `main.ts:636`, `:641-646`, `:659` | Features de produto, não do boot |
| Duas entradas HTML (`index.html` + `pet.html`) | `vite.renderer.config.ts:31-34` | Consequência do pet ser opt-in |

---

## 5. Lacunas

- ~~lacuna: comparação byte a byte de `main.js` vs `.vite/build/main.js`~~ — **FECHADA**: `cmp` diverge no char 86; chunks distintos (`main-B-7tm2vZ.js` vs `main-DU3Ubku5.js`). Ver §3 item 1.
- **lacuna:** o corpo de `src/preload/preload.ts` entre as linhas 60 e 757 (tipos, helpers, `addListener`, `PtyGapBuffer`) não foi lido — só o objeto `api` (`:758-1586`) e o cabeçalho de imports. A **forma** de validação de payload no preload (se há zod no receptor, como diz `ARCHITECTURE.md §B.3`) não foi confirmada.
- **lacuna:** `isLiveTrustedMainWindowSender` foi lido só até `trusted-ipc.ts:80`; o restante da função (checagem de `senderFrame`, comparação com `mainFrame`) não foi verificado até o fim.
- **lacuna:** não confirmei onde `MAIN_WINDOW_VITE_NAME` recebe valor em runtime — só que é declarado como magic global do plugin (`src/main/forge-env.d.ts:5-6`) e consumido em `main.ts:716`.
- **lacuna:** o caminho de boot no **Windows** e no **Linux** não foi traçado. Vi apenas o housekeeping do Squirrel (`main.ts:384-393`) e o `window-all-closed` que só sai fora do darwin (`main.ts:989-993`). Toda a fase B3 (varredura de supervisores) é darwin-only.
- **lacuna:** `src/main/pty/pty-host-core.ts` (a ponte pura, onde vive `createPtyHostBridge`) não foi lido — só sua interface consumida por `pty-host-client.ts`.
- **lacuna:** `installRestoredAgentsGate()` (`src/renderer/main.tsx:9`) não foi aberto; não sei o que ele segura nem por quanto tempo.
- **lacuna:** não medi tempos reais de boot em nenhuma fase; os prazos citados são os **configurados**, não os observados: slow notice 10s (`main.ts:1118-1121`), teto de quit 45s (`main.ts:892`), mount deadline 20s (`reliability/renderer-mount-watchdog.ts:1`, usado em `window.ts:461`), poll de mount 2s (`window.ts:652`), watchdog de load a cada 3s (`window.ts:650`).
- **lacuna:** `browser-preload.ts` foi caracterizado apenas pelo comentário em `forge.config.ts:400-402`; não li o arquivo para confirmar que de fato não expõe API de página.

---

## 6. Auditorias relacionadas

- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) — documento de **design** datado de 2026-07-03. **Tratar como hipótese, não como prova.** Divergências e confirmações encontradas:

  | `ARCHITECTURE.md` diz | O código faz | Fonte |
  |---|---|---|
  | §B.1 "4 processos" com MessagePort main↔renderer | Confirmado no espírito, mas o transporte main↔renderer é `ipcRenderer.invoke/on` via preload, não MessagePort | `preload.ts:806` e todo o objeto `api` |
  | §B.3 "Stream de bytes do PTY (`session:data`) usa **MessagePort transferido** à instância xterm" | **Não implementado.** O próprio §B.2 se corrige mais abaixo: "O stream de bytes hoje volta ao main (não vai direto ao xterm)… a MessagePort direta ao xterm da §B.3 é otimização futura". As duas seções do mesmo documento se contradizem | `docs/ARCHITECTURE.md` §B.2 vs §B.3 |
  | §B.3 "Contrato (design, `src/shared/ipc/contracts.ts`)" | **Esse arquivo não existe.** Os canais vivem em `src/shared/channels.ts` e em módulos por domínio (`orch-channels.ts`, `settings-types.ts`, `voice-channels.ts`, `vision-ipc.ts`, `pet-types.ts`, …), importados em `preload.ts:2-18` | `src/shared/channels.ts:184`; imports em `preload.ts:2-57` |
  | §B.3 canais `session:spawn/write/resize/kill` | Os nomes reais estão em `PTY_CHANNELS`, não `session:*`; o namespace exposto é `nexus.pty` | `preload.ts:815`, `src/shared/channels.ts` |
  | §B.2 "`pty-host-client.ts` é o **único** módulo PTY que importa electron" | **Impreciso como escrito, verdadeiro na intenção.** Três módulos em `src/main/pty/` importam `electron`: `pty-host-client.ts:2` (valor: `utilityProcess`), `pty-ipc.ts:1` (valor: `ipcMain`) e `pty-manager.ts:5` (**`import type`** — apagado na compilação). O ponto que o design queria garantir — `pty-manager` fora do grafo electron em runtime, logo testável sem forkar processo — **se sustenta**, porque o import dele é type-only. Mas `pty-ipc.ts` é um import de valor, então "único" é falso ao pé da letra | `pty-host-client.ts:2`, `pty-ipc.ts:1`, `pty-manager.ts:5` |
  | §B.2 "`pty-host-entry.ts` … executor burro, nunca decide política" | **Confirmado**, e o próprio arquivo repete a afirmação | `pty-host-entry.ts:8-11` |
  | §B.2 supervisor `nexus-pty-supervisor` assinado no macOS | **Confirmado** no empacotamento | `forge.config.ts:266-268` (`resources/native/darwin/nexus-pty-supervisor` em `extraResource`) |

  > A divergência de §B.3 é esperada: o cabeçalho do documento declara a fase como design-only. Registrada aqui para que ninguém a cite como descrição do sistema atual.

- [`../2026-08-05-electron-slim.md`](../2026-08-05-electron-slim.md) — **lacuna:** não lido nesta passagem; provável sobreposição com §2.3 (empacotamento/prune).
- [`../2026-08-05-tauri-spike.md`](../2026-08-05-tauri-spike.md) — contexto da decisão de stack (ver memória do projeto: arquitetura viável, custo não compensa).
- [`../2026-07-23-auditoria-xss-renderer-electron.md`](../2026-07-23-auditoria-xss-renderer-electron.md) — **lacuna:** não lido; sobreposição direta com §2.6 (CSP) e §2.4 (fronteira de IPC).
- [`./F6-pty-grid-canvas.md`](./F6-pty-grid-canvas.md) — dono da frente F6; o PTY host aqui é traçado só até o fork (§1 fase E). Ciclo de vida de sessão, ownership e o supervisor darwin são de F6.
- [`./F2-mcp-hub.md`](./F2-mcp-hub.md) — `registerMcpIpc()` (`main.ts:559`) e `initOrchestration()` (`main.ts:641`) são citados aqui só como passos de boot.
- [`./F3-hooks-lifecycle.md`](./F3-hooks-lifecycle.md) — o bootstrap de hooks gerenciados (`main.ts:802-835`) é traçado aqui só como fase B15.

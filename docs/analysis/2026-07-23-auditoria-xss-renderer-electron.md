# Auditoria XSS, renderer e boundaries Electron — 2026-07-23

## Escopo e método

Auditoria estática e testes de regressão sobre:

- `src/renderer`, `src/preload`, HTML/Vite e protocolo `nexus-app://`;
- `BrowserWindow`, `WebContentsView`, `webPreferences`, CSP e navegação;
- `window.open`, redirects, `shell.openExternal`, `postMessage` e DOM sinks;
- storage de credenciais, Remote PWA, service worker e Companion web;
- arquivos/previews e IPC exposto pelo preload.

Um item só foi classificado como vulnerabilidade quando havia um fluxo
controlável chegando a um sink, boundary ou segredo. Ocorrências estáticas sem
fluxo atacante foram registradas apenas como hardening residual.

## Resultado

Cinco falhas ou boundaries fail-open confirmados foram corrigidos. Nenhum
achado alto conhecido deste recorte permanece aberto após os patches e testes
abaixo.

### NX-RENDER-001 — segredo do QR persistia no fragmento

- Regra: `JS-TOKEN-URL-001`
- Severidade antes do fix: alta
- Local: `companion/worker.js:21`
- Entrada/sink: o QR entrega `room + chave AES-GCM + write token` no fragmento
  da URL. O cliente importava a chave, mas mantinha o fragmento no endereço e
  no item de histórico.
- Impacto: quem obtivesse esse item enquanto a sala estivesse ativa teria o
  material necessário para entrar na sala e, no QR de controle, escrever no
  terminal remoto.
- Correção: capturar o fragmento uma única vez e executar
  `history.replaceState` antes do primeiro `await`. A conexão usa somente a
  cópia já capturada.
- Prova: `companion/worker-security.test.ts:13-71` executa o APP_JS em DOM real,
  exige `location.hash === ""` e confirma que a rota WSS continua correta.
- Falso positivo descartado: fragmentos não são enviados no HTTP `Referer`,
  mas continuavam persistidos localmente; portanto não era vazamento de rede,
  e sim retenção indevida de credencial.

### NX-RENDER-002 — Remote PWA permitia clickjacking

- Regra: `WEB-FRAME-001`
- Severidade antes do fix: alta
- Local: `src/main/remote/remote-bridge.ts:927-946`
- Entrada/sink: ao expor a bridge na LAN, uma origem maliciosa podia enquadrar
  o PWA. Uma sessão já pareada autoautentica e `pane.input` escreve em um PTY
  real, portanto uma sobreposição visual podia induzir comandos.
- Pré-condições: bridge acessível, certificado aceito pelo navegador e sessão
  pareada naquele perfil.
- Correção: CSP `frame-ancestors 'none'` e defesa legada redundante
  `X-Frame-Options: DENY`.
- Prova: `src/main/remote/remote-bridge.test.ts:170-203` verifica os dois
  cabeçalhos na resposta HTTPS real e também confirma que o service worker não
  contém estado de autenticação.

### NX-RENDER-003 — redirect 30x contornava a policy da janela OAuth

- Regra: `ELECTRON-NAV-002`
- Severidade antes do fix: média
- Local: `src/main/adapters/omp-auth-window.ts:52-67`
- Entrada/sink: a resposta do endpoint OAuth é remota. A janela validava
  `will-navigate`, porém o Electron emite redirects HTTP em
  `will-redirect`; assim, um 30x podia atingir um esquema recusado pela policy.
- Impacto: navegação da janela de autorização para `file:`, `data:`,
  `javascript:` ou HTTP não-loopback, contrariando o boundary declarado. O
  sandbox, `contextIsolation` e a ausência de Node reduziam o impacto, mas não
  corrigiam o bypass.
- Correção: uma única função instala a mesma allowlist em `will-navigate` e
  `will-redirect`.
- Prova: `src/main/adapters/omp-auth-window.test.ts:70-102` exige ambos os
  listeners, bloqueia `file:` e preserva HTTPS permitido.

### NX-RENDER-004 — CSP da janela principal falhava aberta

- Regra: `JS-CSP-001`
- Severidade antes do fix: média
- Local: `src/main/window.ts`
- Boundary: a flag era marcada antes de o Electron aceitar
  `onHeadersReceived`; CSP e IPC opcional compartilhavam o mesmo `try/catch`, e
  a `BrowserWindow` continuava até `loadURL` quando a instalação falhava.
- Impacto: uma falha operacional da sessão Electron podia carregar o renderer
  sem a defesa CSP declarada. Não foi encontrado input atacante que causasse a
  exceção, portanto o risco era fail-open de inicialização, não bypass remoto
  provado.
- Correção: a policy é construída e instalada antes da construção da janela; a
  flag só é gravada depois do hook aceito. Falha mostra erro nativo, retorna sem
  criar renderer, interrompe o bootstrap e encerra o app. A policy também nega
  framing explicitamente com `frame-ancestors 'none'`.
- Prova: `src/main/window-security.test.ts` força
  `onHeadersReceived` a lançar, exige zero construções de `BrowserWindow` e
  confirma que uma tentativa seguinte volta a registrar a CSP.

### NX-RENDER-005 — efeitos nativos da janela não autenticavam o renderer

- Regra: `JS-URL-001`
- Severidade antes do fix: baixa
- Local: `src/main/window.ts`
- Entrada/sink: qualquer `WebContents` capaz de invocar os canais compartilhados
  alcançava `shell.openExternal`, login OAuth ou abertura dos avisos legais;
  somente a URL externa tinha validação adicional de protocolo HTTPS.
- Impacto: uma superfície Electron auxiliar comprometida poderia abrir páginas
  HTTPS arbitrárias no navegador do usuário. Protocolos executáveis já eram
  negados, por isso não havia execução local direta confirmada.
- Correção: os três canais reutilizam autoridade vinculada à identidade exata
  da janela principal, `WebContents`/janela vivos, frame principal e origem
  original do renderer. O protocolo continua fail-closed em HTTPS; não foi
  criada allowlist de domínios genérica porque OAuth/device-flow legítimos usam
  hosts dinâmicos.
- Prova: `src/main/window-security.test.ts` cobre sender não registrado,
  subframe, navegação para outra origem, crash/destruição, os canais auth/legal
  e protocolos `http:`, `file:`, `javascript:` e `data:`.

## Cobertura negativa confirmada

### DOM/XSS

- Não há `dangerouslySetInnerHTML`, `DOMParser`, `document.write`, `eval` ou
  `new Function` no renderer de aplicação.
- O `innerHTML` de `src/main/window.ts:35` recebe somente markup constante da
  tela de recuperação, sem concatenação de dados externos.
- O Companion ainda usa `innerHTML` em `setStatus`, mas todos os chamadores
  passam literais locais; panes, terminal, nomes, mensagens e frames remotos
  chegam ao DOM por `textContent`.
- O Remote PWA monta missões, panes, erros e saída de terminal com
  `textContent`; nenhum dado WebSocket alcança parser HTML.

### Isolamento Electron

- Janela principal: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webviewTag: false`, `webSecurity: true` e
  `allowRunningInsecureContent: false` em `src/main/window.ts:299-323`;
  popups e navegação são negados em `src/main/window.ts:342-345`.
- Pet: os mesmos flags e preload mínimo em
  `src/main/pet/pet-window.ts:817-868`.
- OAuth OMP: sandbox, context isolation, Node desligado, partição efêmera,
  popups negados e permissões recusadas em
  `src/main/adapters/omp-auth-window.ts:69-90`.
- Browser embutido não recebe `window.nexus`: usa preload fechado, sessão
  separada, permissões/downloads negados e SSRF/DNS-rebinding fail-closed em
  `src/main/browser/browser-manager.ts:394-452,630-687`.

### Preload e IPC

- O preload principal expõe objeto tipado, não `ipcRenderer`, em
  `src/preload/preload.ts:1270`.
- O preload de páginas arbitrárias não chama `contextBridge`; ele aceita
  somente comandos enumerados/capados do main e correlaciona respostas pelo
  WebContents em `src/preload/browser-preload.ts:64-95` e
  `src/main/browser/browser-automation-runtime.ts`.
- Não há uso de `window.postMessage` no renderer/preload. Os `postMessage`
  encontrados pertencem ao `utilityProcess` do host PTY e não atravessam uma
  origem web.

### Protocolo, arquivos e previews

- `nexus-app://` não habilita `bypassCSP`; valida método, origem, credenciais
  URL, separadores codificados, contenção lexical, `realpath` e symlinks em
  `src/main/renderer-protocol.ts:79-200`.
- O explorer resolve caminhos contra o workspace autorizado e valida
  descritores/identidade contra corrida de symlink em
  `src/main/persistence/files-ipc.ts`.
- Preview de mídia aceita somente extensões/MIME de imagem, áudio e vídeo,
  limita tamanho e resolve `storageKey` dentro do workspace em
  `src/main/media/media-ipc.ts:80-89,208-231`.
- Spritesheets do pet aceitam somente data URLs base64 de PNG/WebP/JPEG,
  limitados e decodificados como imagem, em `src/shared/pet-types.ts:179-181`
  e `src/renderer/components/settings/PetSection.tsx:270-307`.

### Service worker e storage

- O service worker remoto cacheia apenas `/`, manifest e ícone, somente em
  GET/same-origin; token e WebSocket nunca entram no Cache Storage em
  `src/main/remote/remote-client-page.ts:45-82`.
- O renderer Electron usa storage web apenas para preferências, métricas e
  estado transitório; chaves de providers ficam no main e retornam apenas
  mascaradas.

## Hardening residual, sem exploração XSS confirmada hoje

1. A janela OMP aceita qualquer origem HTTPS e qualquer callback HTTP
   loopback. Isso suporta brokers/provedores dinâmicos, mas uma origem de
   broker comprometida pode apresentar phishing numa janela sem barra de URL.
   Próximo passo: allowlist por provedor e callback loopback exato, ou
   confirmação nativa da origem normalizada.

2. A CSP da Remote PWA ainda usa `script-src 'unsafe-inline'`/`connect-src
   wss:`. Não há sink XSS atual, então isto não foi promovido a vulnerabilidade
   explorável. **Atualização pós-auditoria (23/07):** o token continua em
   `localStorage`, mas deixou de ser bearer suficiente: uma chave ECDSA P-256
   privada não-extraível fica no IndexedDB e assina desafio single-use; a bridge
   vincula token + deviceId + chave pública. O próximo hardening independente
   continua sendo script externo/hash CSP.

## Validação executada

- Testes focados de segurança: 104/104 verdes em 12 arquivos.
- Incluídos: Companion, OMP OAuth, Remote PWA, browser network/automation,
  protocolo `nexus-app`, arquivos, mídia, pet, lifecycle/CSP da janela e source
  audit.
- `npx tsc --noEmit`: verde.
- `git diff --check` dos arquivos tocados: verde.
- Nenhum commit ou release foi criado por esta auditoria.

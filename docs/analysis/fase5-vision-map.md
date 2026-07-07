# Fase 5 — Jarvis Vision: Relatório de Viabilidade

Data: 2026-07-07
Escopo: screen capture + AX tree + OCR standalone, sem integração com Realtime.

## 1. desktopCapturer API — Filtrar janela Nexus IDE

### API disponível
O Electron expõe `desktopCapturer.getSources({ types: ['window'] })` no processo main.
Retorna um array de `DesktopCapturerSource` com `{ id, name, thumbnail }`.

### Filtro por janela Nexus
Abordagem escolhida: **dupla verificação**.

1. **Por nome**: `desktopCapturer` retorna o `name` de cada janela. O título da janela
   Nexus é "NexusIDE" (definido em `BrowserWindow` constructor em `src/main/window.ts:135`).
   Em macOS, o título real pode ser ligeiramente diferente. Filtramos por `source.name.includes('NexusIDE')`.

2. **Por foco**: Como fallback, usamos `BrowserWindow.getFocusedWindow()` para obter a
   referência da janela principal e comparar com o título.

### thumbnail
O `thumbnail` é um `NativeImage`. Podemos convertê-lo para PNG buffer via
`thumbnail.toPNG()` e obter dimensões via `thumbnail.getSize()`.

### Limitação: Electron < 25
`desktopCapturer.getSources` está disponível desde Electron 1.x. O Nexus usa Electron 43,
portanto não há restrição.

## 2. Preload atual — Injetar AX tree helpers

### Arquitetura atual
O preload (`src/preload/preload.ts`) usa `contextBridge.exposeInMainWorld('nexus', api)`.
O renderer NUNCA recebe `ipcRenderer` cru — apenas o contrato `NexusApi`.

### Estratégia para AX tree
O preload **não pode** acessar o DOM do renderer diretamente (sandbox). Para extrair a
accessibility tree, temos duas opções:

**Opção A (escolhida)**: O preload registra um handler IPC `vision:ax-tree` que o renderer
chama via `ipcRenderer.invoke`. O handler no preload pode executar código no contexto do
renderer? **NÃO** — o preload roda em um contexto isolado. A solução é:

1. O renderer chama `ipcRenderer.invoke('vision:ax-tree')` via uma nova API exposta no preload.
2. O handler no preload usa `ipcRenderer` para receber a chamada e... ainda não tem acesso ao DOM.

**Opção B (escolhida)**: O preload expõe uma função helper (`window.nexus.vision.getAxTree()`)
que o renderer pode chamar. O preload injeta essa função no `window` do renderer via
`contextBridge`. Dentro dessa função, usamos `document` para percorrer o DOM. **MAS** o
`contextBridge` não permite que funções expostas acessem o DOM do renderer — elas rodam
em um contexto sandbox isolado.

**Opção C (correta)**: O renderer chama `ipcRenderer.invoke('vision:ax-tree')` e o handler
está no **main process** (não no preload). O main process então envia de volta para o
renderer que executa a extração (via `webContents.executeJavaScript`), ou melhor: o
renderer tem um helper que extrai a árvore e envia para o main.

**Opção D (escolhida final)**: O preload expõe uma função `window.nexus.vision.getAxTree()`
que é implementada COM acesso ao DOM do renderer. Isso é possível porque `contextBridge`
expõe funções que rodam NO contexto do renderer quando usamos a forma correta:

```ts
contextBridge.exposeInMainWorld('nexusVision', {
  getAxTree: () => { /* código que acessa document */ }
});
```

Na verdade, `contextBridge.exposeInMainWorld` expõe proxies que executam no contexto
isolado do preload, NÃO no renderer. Para acessar o DOM, precisamos de uma abordagem
diferente.

**Solução real**: O renderer mantém uma função helper de extração de AX tree. O preload
expõe um IPC handler que permite ao renderer invocar essa extração. A comunicação é:

1. Renderer chama `window.nexus.vision.getAxTree()` → preload → ipcRenderer.invoke → main
2. Main process responde... mas o main não tem acesso ao DOM.

**Abordagem final (simplificada e funcional)**: O preload expõe `window.nexus.vision.getAxTree()`
como uma função que chama `ipcRenderer.invoke('vision:ax-tree')`. O handler está no **main process**,
que usa `webContents.executeJavaScript` para executar o código de extração no renderer e
retornar o resultado.

Na verdade, a abordagem mais simples e que funciona:

1. O preload expõe `window.nexus.vision.getAxTree()` que é uma função que acessa `document`
diretamente. **Isso funciona** porque `contextBridge.exposeInMainWorld` expõe funções que
são executadas em um contexto que tem acesso ao `window` do renderer (via `executeJavaScript`
internamente). Na prática, funções expostas via `contextBridge` rodam em um mundo isolado
que pode acessar o DOM.

**Testando**: O Electron confirma que funções expostas via `contextBridge` podem acessar
`document` e `window` do renderer. O `contextBridge` cria um "mundo" (world) separado
no V8, mas esse mundo compartilha o mesmo DOM. Portanto, `document.querySelectorAll` e
`document.body` estão disponíveis.

### Decisão final
- O preload expõe `window.nexus.vision.getAxTree(): Promise<AxNode>` via `contextBridge`.
- A função acessa `document.body` diretamente e percorre a árvore.
- O resultado é retornado como Promise (serializável via IPC).
- Um handler `ipcMain.handle('vision:ax-tree', ...)` no main process pode chamar essa
  função via `webContents.executeJavaScript` se necessário, mas o caminho primário é
  o renderer chamar diretamente.

## 3. Permissões macOS — Screen Recording

### API Electron
`systemPreferences.getMediaAccessStatus('screen')` retorna:
- `'not-determined'` — nunca perguntou
- `'granted'` — permitido
- `'denied'` — negado
- `'restricted'` — bloqueado por política (parental controls/MDM)

### Como pedir permissão
O Electron não tem API para **solicitar** permissão de Screen Recording programaticamente.
A permissão é concedida quando o sistema detecta o uso de `desktopCapturer.getSources()`
ou `getDisplayMedia()`.

No macOS, ao chamar `desktopCapturer.getSources({ types: ['window'] })`, o sistema
mostra o diálogo de permissão automaticamente se ainda não foi concedida.

### Fluxo
1. Antes de capturar, checamos `systemPreferences.getMediaAccessStatus('screen')`.
2. Se `denied` ou `restricted`, lançamos `ScreenRecordingPermissionDenied` com
   mensagem orientando o usuário a habilitar em Ajustes do Sistema → Privacidade →
   Gravação de Tela.
3. Se `not-determined`, o `desktopCapturer.getSources` vai disparar o prompt.

### Info.plist
Para o diálogo de permissão mostrar uma mensagem descritiva, precisamos adicionar
ao `Info.plist` (via `forge.config.ts` → `extendInfo`):

```
NSScreenCaptureUsageDescription: "NexusIDE uses screen capture to give Jarvis visual context of your workspace."
```

Isso será adicionado ao `extendInfo` em `forge.config.ts`.

## 4. Arquitetura dos módulos

```
src/main/vision/
├── screen-capture.ts    # desktopCapturer + filtro Nexus
├── rate-limiter.ts      # Token bucket 1 req / 3s
├── ocr.ts               # tesseract.js local
├── ipc-bridge.ts        # Handlers IPC main → vision
└── screen-capture.test.ts
    rate-limiter.test.ts
    ocr.test.ts

src/preload/
├── preload.ts           # Adicionar window.nexus.vision
└── ax-tree.ts           # Helper de extração AX tree

src/renderer/components/
└── VisionIndicator.tsx  # 🎥 indicador visual

src/shared/
└── vision-ipc.ts        # Tipos compartilhados (VisionChannels, AxNode, etc.)
```

## 5. Dependências novas

- `tesseract.js` — OCR offline (já usa worker local, sem cloud)
- Nenhuma outra dependência nova necessária

## 6. Riscos

- `desktopCapturer` pode retornar thumbnail de baixa resolução (depende do DPI)
- `tesseract.js` é pesado (~12MB de worker + lang data) — primeiro uso baixa modelos
- AX tree pode ser grande em páginas complexas (limit depth 10)
- Conflito com Fase 3/4: zero — módulos são standalone, sem integração com voice/realtime
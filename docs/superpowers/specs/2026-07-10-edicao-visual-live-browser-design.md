# Edição Visual no Browser Pane ("Live Design") — Estudo de Viabilidade e Planejamento

**Data:** 2026-07-10 · **Status:** IMPLEMENTADO + HARDENING DE RELEASE · **Autor:** estudo conduzido com pesquisa profunda (web + engenharia reversa de código aberto + mapeamento do próprio Nexus)

> Pergunta do produto: "o Cursor tem aquela coisa de editar o site pela aba dele, arrastar etc. O impeccable live e o Onlook/OpenDesign também. Dá pra fazer no Nexus? O terminal codando torna isso possível? Como, de que forma, e é possível?"

---

## 1. Veredito executivo

**É viável, e o Nexus está em posição melhor do que parece.** O Nexus já tem ~40% da fundação construída: browser embutido (`WebContentsView`) com preload isolado que executa automação de DOM (read/inspect/click/fill com refs opacas), servidor MCP embutido, agentes CLI em panes PTY e tools de arquivo com confinamento de workspace. O que falta é exatamente o "miolo visual": element picker + overlay, extração de contexto rico do elemento, mapeamento DOM→código e o loop de write-back.

**Resposta direta às perguntas:**

- **"O terminal codando seria possível?"** — Sim, e é o caminho recomendado para o MVP. É **exatamente o modelo do Cursor**: a seleção visual vira *contexto* para o agente de IA, e o agente (o CLI no pane PTY, via MCP) localiza e edita o código. O Cursor não tem write-back determinístico — verificado nas fontes oficiais: *"The agent will locate the relevant components and update the underlying code for you"*.
- **"De que forma?"** — Em fases: (1) seleção de elemento → contexto → agente edita (paridade com Cursor 2.0/2.2); (2) sidebar de design com preview otimista de estilos na página + "Aplicar" via agente; (3) write-back determinístico opcional (padrão Onlook) para estilos e drag/reorder, usando as peças Apache-2.0 do Onlook.
- **"É possível?"** — Sim. O risco não é técnico-fundamental, é de **polimento do loop** (HMR, ambiguidade de componentes repetidos, sincronização do overlay). O próprio Cursor, com todo o time deles, ainda tem instabilidades documentadas nessa feature (janeiro/2026: drag só funciona em estruturas simples; reorder visual que o agente não consegue mapear de volta pro código). Isso calibra expectativa: MVP "select → agente" é baixo risco; drag estrutural determinístico é a parte difícil e fica pro final.

**Estimativa de esforço (ordem de grandeza):** Fase 1 (MVP select-to-agent): ~1–2 semanas de trabalho focado. Fase 2 (sidebar de estilos + preview otimista): ~2–3 semanas. Fase 3 (write-back determinístico + drag): ~4–8 semanas e é onde mora o risco. Detalhe em §8.

---

## 2. O que cada player realmente faz (fatos verificados)

### 2.1 Cursor

Fatos confirmados em fontes oficiais (blog/changelog/docs do Cursor, verificação adversarial 3-0):

- **Duas features distintas**: (a) *Browser Controls* (v1.7+): o agente controla um Chromium via CDP (tools MCP); (b) *Browser Layout & Style Editor* (v2.2+, 11/dez/2025): webview embutida com seleção visual de elemento e edição de CSS; layout "Browser" dedicado no v2.3+. O browser embutido ficou GA no Cursor 2.0 (29/out/2025) — *"Browser can now be embedded in-editor, including powerful new tools to select elements and forward DOM information to the agent."*
- **Arquitetura**: *"Browser runs as a secure web view and is controlled using an MCP server running as an extension"* — ou seja, o mesmo padrão que o Nexus já tem (view embutida + MCP), não um Chromium externo.
- **Sidebar de design**: controles de position/layout, dimensões, cores, aparência e teste de temas.
- **Write-back é 100% agêntico**: *"click the apply button to trigger an agent that updates your codebase. The agent translates your visual changes into the appropriate code modifications."* Não existe mapeamento determinístico clique→arquivo:linha (é feature request em aberto sem resposta oficial até abr/2026). Em sites React, o select element puxa dados do React DevTools (nome do componente, props) e o agente busca no codebase; em Angular não há assist de framework e mesmo assim funciona via busca agêntica.
- **Limitações reais reportadas** (não-oficiais, teardown jan/2026): select element para de funcionar com browser em janela separada; crashes; drag-and-drop de reordenação só em estruturas simples; caso concreto de reorder visual bem-sucedido que o agente não conseguiu mapear de volta ao código. Allowlist de origens é best-effort (redirects e `window.location` escapam).

### 2.2 Onlook (open-source, "Cursor for Designers", ~24.7k estrelas)

Engenharia reversa completa do monorepo atual (`onlook-dev/onlook`) e do repo da era desktop (`onlook-dev/desktop`). **Licença: Apache-2.0 confirmada na raiz e nos 19 package.json** (era desktop também, incluindo o plugin SWC em Rust). É a fonte técnica mais valiosa para nós. Resumo do que a leitura do código revelou:

- **Mapeamento elemento→código teve 3 gerações**: (G1) plugin Babel/SWC de build que comprimia `{path, startTag, endTag, component}` num `data-onlook-id`; (G2, era Electron) **sem plugin de build**: um `RunManager` no main process pré-processa os arquivos do projeto com `@babel/traverse` injetando IDs aleatórios, mantém `Map<id, TemplateNode>` em memória, observa mudanças com `@parcel/watcher` (com set `selfModified` anti-eco) e **remove os IDs no stop**; (G3, web atual) injeção de `data-oid` (nanoid de 7 chars) na camada de filesystem do editor, com índice `oid → {path, startTag/endTag{line,column}, component, dynamicType}` persistido em `.onlook/index.json` no projeto do usuário.
- **Embed**: era Electron usava `<webview>` + preload com `contextBridge`; a web usa iframe cross-origin + penpal (postMessage). A migração pra web foi por fricção de download/setup e colaboração — **documentam explicitamente que o iframe é mais limitado e exigiu workarounds** (gravar script em `public/`, editar o layout do usuário via AST pra inserir `<Script>`). Em Electron, o preload dá tudo isso "de graça".
- **Overlay**: desenhado **no host** (editor), com rects vindos do frame e adaptados via `DOMMatrix` do canvas; refresh reativo com debounce; re-consulta (nunca streaming). *No Nexus isso inverte: nossa `WebContentsView` oclui o React do IDE, então o overlay tem que ser desenhado dentro da página via preload (§5.2).*
- **Write-back determinístico (pipeline completo)**: ação → requests por `oid` → **conversor CSS→Tailwind vendorizado (~3.5k linhas, standalone)** + `twMerge` → localizar nó pelo índice → transformar AST (`addClassToNode` suporta `className` string ou `cn(...)`) → gerar com `@babel/generator` `retainLines: true` + prettier → gravar → HMR → `MutationObserver` reconcilia (transplanta atributos do nó otimista pro nó real que chega do HMR).
- **Drag/reorder**: elemento vira `position:fixed` + stub placeholder inserido geometricamente entre irmãos (índice calculado por flex/grid direction); no código, splice dos filhos JSX + **injeção forçada de `key="olk-…"`** (sem isso o React reconcilia por posição e ignora o move visualmente).
- **Texto inline**: ProseMirror no host sobre o elemento (elemento real fica `opacity: 0` via stylesheet injetado); cada tecla replica no DOM e no final vira edição de AST.
- **Undo/redo**: pilha de Actions invertíveis (`{original, updated}` trocados no undo), com transações para drags contínuos; cada push já grava código.
- **IA**: seleção → `oid` → snippet pré-extraído do índice entra no contexto do chat; agente com tools de código executadas no cliente contra o mesmo funil de escrita (re-injeção de OIDs automática); guard-rail no system prompt: *"NEVER remove, add, edit or pass down data-oid attributes"*.
- **Armadilhas que só o código revela** (§7 detalha): componente instanciado N vezes = mesmo oid em N nós DOM (resolvem com par `oid`/`oiid` + busca do n-ésimo uso no pai — recursivo); listas `.map()` = editar 1 edita todos; eco de watcher com 3 escritores concorrentes; **o processamento reformata o arquivo inteiro do usuário com prettier no primeiro toque**; na web os `data-oid` são commitados e vazam pra produção do usuário (na era Electron eram limpos no stop — decisão melhor pra nós).

### 2.3 stagewise (engenharia reversa das 3 eras)

O repo tem **3 eras**, e a trajetória valida exatamente a nossa tese:

- **Era toolbar (jul/2025):** componente npm por framework (`<StagewiseToolbar enabled={NODE_ENV==='development'}>`) dentro do app do usuário, falando com uma extensão VS Code via WebSocket (srpc, porta 5746 com descoberta por ping). O prompt ia pro Cursor via hack (injetava o texto como *diagnostic* fake e disparava `composer.fixerrormessage`).
- **Era CLI (set/2025):** CLI Express que **proxia o dev server do usuário** e injeta a toolbar só em respostas `sec-fetch-dest: document` — zero mudança no código do usuário. Agente embutido local.
- **Era atual (jul/2026):** **IDE desktop em Electron** (electron-forge + vite, como o Nexus) com browser embutido: preload em toda página + **injeção de um "React analyzer" no main world via CDP `Runtime.evaluate`**, registrado sob `Symbol.for('__sw_react_analyzer__')` "para ser menos detectável". Agente próprio embutido (Vercel AI SDK, BYOK) + protocolo karton (state-sync/RPC sobre WebSocket).

**Como extraem contexto do elemento (código lido):** walk do fiber React (`__reactFiber$*`, com fallbacks `_reactRootContainer` e `__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers→findFiberByHostInstance`), subindo até 20 fibers coletando `displayName/name`, detectando RSC via `_debugOwner.env === 'server'`; Vue: `el.__vueParentComponent?.type?.__name` (só nome — **não** usam o `__file` disponível); Angular: `window.ng.getComponent(el)`; **Svelte: não existe plugin em era nenhuma**. **Ponto crucial: o stagewise NUNCA extrai arquivo:linha** — a ponte DOM→código é "nomes de componente + attrs/classes/XPath → o agente greppa o codebase" (existe um slot `codeMetadata {relativePath, startLine…}` no schema atual, mas é inicializado vazio — infra preparada, não populada).

**Payload → agente:** evoluiu de prompt pseudo-XML (`<element><tag><id><classes><attributes><text><structural_context><styles>`) para um objeto `SelectedElement` (zod) muito rico: tagName, xpath, attributes, boundingRect, innerText, pais/irmãos/filhos recursivos (depth 10), computed styles completos, pseudo-elementos `::before/::after`, estados `:hover/:active/:focus`, `frameworkInfo.react {componentName, props serializadas, isRSC}`, `backendNodeId` (CDP), persistido como arquivo `.swdomelement` + screenshot anexado ao chat. **Este schema é a melhor referência de "contrato de contexto de elemento" que encontramos — vale espelhar o formato (schema não é código copiável, é design).**

### 2.4 impeccable live (skill local, inspecionado diretamente)

Terceiro modelo de arquitetura, sem browser embutido: helper HTTP local (~porta 8400) + `<script>` injetado no HTML do projeto → picker/overlay/anotações (comentários + rabiscos sobre screenshot) no browser normal do usuário → agente em long-poll recebe eventos → **mapeamento por busca heurística no source** (id/classes/tag/texto do elemento, com erro `element_ambiguous` e fallback agent-driven) → variantes escritas no código e trocadas via HMR → accept/discard com "carbonize" (limpeza pós-aceite). Pontos a aprender: (a) zero configuração de build; (b) o contrato de eventos (generate/steer/accept/discard/manual_edit_apply) é um bom vocabulário de produto; (c) precisa patchear CSP do projeto do usuário para o script externo — **problema que o Nexus não tem**, pois preload de `WebContentsView` não é bloqueado pelo CSP da página.

### 2.5 Open Design (nexu-io/open-design) e outros

- **Open Design NÃO é um editor visual select-and-drag** (claim extraída de fontes, não verificada adversarialmente por limite de sessão): é um workspace agêntico onde CLIs (Claude Code, Codex, etc.) geram artefatos HTML renderizados em iframe `srcdoc` sandboxed com parser de streaming, e se posiciona explicitamente **contra** manipulação direta em canvas. Licenciamento com metadados inconsistentes (LICENSE MIT vs package.json divergente). Útil como referência de "painel de artefatos", não para esta feature.
- Ecossistema restante (Plasmic, Webstudio, GrapesJS, Puck): são page-builders com runtime/registry próprios — **não** editam código-fonte arbitrário do usuário; irrelevantes para o nosso caso de uso além de inspiração de UI.

---

## 3. Anatomia do problema (os 4 subproblemas)

Toda ferramenta dessa categoria resolve os mesmos 4 subproblemas. As escolhas de cada player:

| Subproblema | Cursor | Onlook (Electron era) | stagewise (era toolbar) | impeccable live |
|---|---|---|---|---|
| **1. Embed + instrumentação** | webview + MCP server como extensão | `<webview>` + preload | script no app do usuário (pacote/plugin) | script injetado no HTML + helper HTTP |
| **2. Seleção + overlay** | picker na webview | overlay no host (canvas) | toolbar dentro da página | overlay dentro da página |
| **3. Mapeamento DOM→código** | React DevTools data + busca agêntica | `data-oid` injetado + índice `oid→arquivo:linha` | internals do framework (fiber etc.) | busca heurística no source |
| **4. Write-back + re-sync** | 100% agente | determinístico (AST + CSS→Tailwind) + HMR reconcile | agente externo | agente + HMR |

O insight de senior: **os subproblemas 1–2 são infra que o Nexus quase toda tem; o 3 é um espectro (heurística → internals → instrumentação) que dá pra subir em camadas; o 4 tem um atalho de baixo risco (agente) que o Cursor validou como produto shippável.** O erro clássico seria começar pelo 3–4 determinísticos (o "Dreamweaver problem": WYSIWYG→código de alta fidelidade é um pântano histórico). As ferramentas novas funcionam porque **ou** delegam o write-back pra um LLM (Cursor, stagewise) **ou** restringem o vocabulário de edição a operações bem definidas sobre JSX+Tailwind (Onlook).

---

## 4. O que o Nexus já tem (inventário com referências)

Mapeamento do repo em 2026-07-10 (branch `fix/mic-permission-v011`):

**Já existe e é reaproveitável direto:**
- Browser embutido `WebContentsView` com `contextIsolation+sandbox` e **preload próprio** (`browser-preload.js`): `src/main/browser/browser-manager.ts:353-367`; view por pane com session partition isolada (`:335`), posicionada sobre o slot React via bounds (`src/renderer/browser/browser-host.ts:22-57`).
- **Automação de DOM no preload com refs opacas** (`e1, e2…`): `src/preload/browser-automation.ts` — comandos `read/inspect/click/fill/wait` (`src/shared/browser-automation.ts:11-16`), hit em elementos interativos, redação de segredos. É o seam natural para picker/overlay/computed-styles: mais casos no `run()` switch (`:503-510`).
- Runtime de correlação request/response main-side: `src/main/browser/browser-automation-runtime.ts:57-93` + wrappers em `browser-manager.ts:595-670`.
- Tools MCP de browser (11) com autorização por pane: `src/main/orch/tools-browser.ts:250-264` (padrão `McpToolDef` + `authorizePaneRef`).
- Agente pode abrir/controlar panes (browser inclusive): `nexus_browser_open` → `pane-registry.ts:383-421` → renderer cria o pane.
- Screenshots do pane: `captureBrowserScreenshot` (`browser-manager.ts:545-577`).
- Caminho renderer→tools (para uma UI de picking no próprio IDE): `window.nexus.mcp.invoke` (`src/preload/preload.ts:640-646`, role `user` com toolset completo).
- Edição de código pelo agente: CLIs nos panes PTY (tools nativas deles) e tools `nexus_file_write`/`nexus_editor_*` confinadas ao workspace (`tools-files.ts:198-240`, `workspace-path.ts:33-89`).

**Gaps identificados (o que a feature precisa criar):**
1. **Element picker + overlay** — não existe nada de hover/highlight/seleção visual.
2. **Contexto rico de elemento** — `inspect` atual não expõe `getComputedStyle`, hierarquia de componentes nem arquivo:linha.
3. **Mapeamento DOM→código** — inexistente (sem source-maps, sem attrs, sem índice).
4. **Dev server do usuário** — não há detecção de porta/URL de dev server nem file-watcher do projeto; `preview-server.ts` só serve build estático. `nexus_terminal_run` tem timeout ≤300s (não roda `npm run dev` contínuo) — dev server vive num pane PTY comum.
5. **Autorização implementada:** panes e eventos de design são escopados por
   `WebContents` + projeto/checkout. Envio ao agente exige pane da mesma janela
   e scope, missão viva, contexto congelado atual e estágio PREVC `execution`.
6. **Overlay do lado React é impossível sobre a view**: a `WebContentsView` nativa oclui o DOM do renderer e captura o ponteiro na sua área — overlay e captura de mouse **têm** que viver no preload/página (constatado no mapeamento; consistente com a supressão já existente em `App.tsx:172-178`).

---

## 5. Arquitetura recomendada

### 5.1 Princípios (amarrados aos requisitos do produto)

1. **Multi-plataforma por construção** (requisito declarado: macOS/Windows/Linux + multi-PC): tudo em APIs Chromium/Electron puras — `WebContentsView`, preload, IPC. Nada de camada nativa de SO para overlay (evita o inferno de DPI/scaling no Windows/Linux: todas as coordenadas em CSS pixels dentro da própria página). `<webview>` está descartado também por recomendação oficial do Electron (tag desencorajada; `BrowserView` deprecado desde o 30; `WebContentsView` é o caminho vendor-endorsed — e é o que já usamos).
2. **Não poluir o repo do usuário.** No MVP, zero atributos persistidos em código do usuário. Se/quando a Fase 3 usar IDs, seguir o blueprint da **era Electron do Onlook** (IDs efêmeros em memória + cleanup no stop), não o da era web (que commita `data-oid` e vaza pra produção).
3. **Write-back agêntico primeiro, determinístico depois.** O agente CLI no pane PTY já é o "executor" do Nexus; a seleção visual é uma nova *fonte de contexto* para ele (modelo Cursor, validado em produção). Determinismo entra só onde o vocabulário é fechado (estilos Tailwind, reorder) e com as peças Apache-2.0 do Onlook.
4. **Config da feature viaja com o projeto** (multi-PC): qualquer estado por projeto (ex.: URL do dev server preferida, framework detectado) em `.nexus/` no workspace, não em caminhos da máquina.
5. **Degradação graciosa por tipo de página**: app do usuário em dev (experiência completa) → app do usuário em build/preview (seleção + contexto, sem HMR) → site third-party qualquer (seleção + screenshot + contexto visual para "clonar/inspirar", sem write-back).

### 5.2 Componentes novos (visão de blocos)

```
┌─ Renderer (IDE) ─────────────────────────────────────────────┐
│ BrowserPane toolbar: botão "Design Mode" + status            │
│ DesignSidebar (fase 2): estilos do elemento selecionado      │
│   └── fala com main via novos BROWSER_CHANNELS (IPC direto)  │
└──────────────────────────────────────────────────────────────┘
┌─ Main ───────────────────────────────────────────────────────┐
│ browser-manager: modo design on/off por pane                 │
│ design-session: estado da seleção, contexto, histórico       │
│ tools-design.ts (novas MCP tools p/ o agente)                │
│ dev-server-registry (fase 1.5): mapeia pane PTY → URL local  │
└──────────────────────────────────────────────────────────────┘
┌─ browser-preload (roda NA página do usuário) ────────────────┐
│ design-mode.ts: picker (elementFromPoint + shadow DOM crawl) │
│   overlay em ShadowRoot fechado (hover/selected rects,       │
│   labels, handles) — CSS px, imune ao CSS da página          │
│   extração de contexto: outerHTML, seletor único, rect,      │
│   computed styles filtrados, cadeia de componentes (fiber/   │
│   __vueParentComponent/__svelte_meta quando app em dev)      │
│   preview otimista: <style> gerenciado por seletor           │
│   (fase 2) drag com stub geométrico (fase 3)                 │
└──────────────────────────────────────────────────────────────┘
```

Decisões e porquês:

- **Overlay dentro da página, num ShadowRoot fechado** (não CDP `Overlay.*`): (a) a view oclui o React do IDE — overlay no host é impossível sem repensar o embed; (b) CDP Overlay dá highlight bonito "DevTools-grade" mas `webContents.debugger` **desanexa à força quando o usuário abre DevTools na mesma view** (limitação documentada) e não desenha handles de drag/labels custom; (c) ShadowRoot fechado + `pointer-events` controlado é o padrão do stagewise/impeccable e sobrevive a qualquer CSS/framework da página. CDP fica como *complemento opcional* futuro (ex.: `DOM.getBoxModel` para precisão, screenshots de nó) — nunca como fundação.
- **Isolated world vs main world (nuance descoberta no stagewise, impacta a L1):** nosso preload roda em *isolated world* (`contextIsolation: true`). O DOM é compartilhado (atributos, geometria, `getComputedStyle` — tudo ok para picker/overlay/L0), mas **propriedades expando de JS nos elementos — `__reactFiber$*`, `__vueParentComponent`, `__svelte_meta` — só existem no *main world* e são invisíveis do preload.** O stagewise resolve injetando o analisador via CDP `Runtime.evaluate`; para nós o caminho mais simples e sem CDP é o preload injetar um **script mínimo de introspecção no main world via `webFrame.executeJavaScript`** (executa como o console do DevTools, não é bloqueado pelo CSP da página), comunicando de volta por `CustomEvent`/`postMessage` com payload validado. Corolário importante: **data-attributes injetados por plugin de build (L3) são atributos de DOM — visíveis do isolated world sem bridge nenhuma** — mais um ponto de robustez dessa camada.
- **Preload > script injetado**: nosso preload roda em todas as páginas do pane sem tocar no projeto do usuário e **não é bloqueado pelo CSP da página** (o impeccable precisa pedir patch de CSP no projeto; o Onlook web precisa gravar script em `public/` e editar o layout do usuário — nós não precisamos de nada disso). É a maior vantagem estrutural do Nexus nessa corrida.
- **Comunicação**: reusar o canal fechado `browser:automation-request/response` com novos comandos (`design_enable`, `design_disable`, `design_get_selection`, `design_set_style_preview`, …) + um canal de **eventos** page→main (hoje o fluxo é só request/response; seleção por clique é um push — precisa de um `browser:design-event` novo no preload/manager).
- **Duas superfícies de consumo da seleção**: (a) **tool MCP** `nexus_design_selection_get` (o agente pega o contexto quando quiser; padrão `McpToolDef` em `tools-design.ts`, entra no toolset via `tools.ts`); (b) **push pro chat/missão ativa** ("Adicionar seleção ao contexto do agente" — injeta no pane PTY do agente um bloco de contexto formatado, como o Cursor faz). A (b) é o que faz a feature *parecer* mágica.

### 5.3 Mapeamento DOM→código em camadas (o coração técnico)

Estado da arte 2025/2026 — **todos os fatos abaixo confirmados por leitura de código-fonte** (react/vue/svelte cores, bippy, locatorjs, click-to-component, code-inspector):

- **React 19 removeu `_debugSource`** (PR facebook/react#28265, merged 2024-02-07; o tipo do Fiber em v18.3.1 tem `_debugSource`, no 19.2.x só `_debugOwner`/`_debugStack`/`_debugTask`) e **removeu `findFiberByHostInstance`** do hook de devtools — as duas pernas da mecânica clássica de click-to-source morreram juntas. `__reactFiber$*` (expando no elemento) continua existindo.
- Substitutos em React 19: `captureOwnerStack` (oficial desde 19.1, **dev-only**, e só funciona em contextos controlados pelo React — retorna `null` em listeners DOM próprios, o que **inviabiliza** usá-lo direto do nosso picker); `fiber._debugStack` (um `Error` capturado no site de criação do JSX — precisa de *symbolication* de sourcemap para virar file:line). A implementação mais robusta disso é o **bippy** (MIT, usado pelo react-scan): `getSource(fiber)` com cadeia de 4 fallbacks documentada (`_debugSource` → `_debugStack` próprio → `_debugStack` de filho → owner-stack legado) + symbolication — a melhor via "sem plugin de build" para file:line em React 19.
- **Plugins de build que injetam data-attributes (a via determinística):** `code-inspector-plugin` (zh-lx, MIT — injeta `data-insp-path/-row/-col` em compile-time, suporta webpack/vite/rspack/esbuild e React/Vue/Svelte+; é o sucessor apontado pelo próprio repo do click-to-component: *"This repo is no longer maintained, use zh-lx/code-inspector instead"*); `@react-dev-inspector/babel-plugin|vite-plugin` v2 (MIT — `data-inspector-{relative-path,line,column}`); `vite-plugin-react-click-to-component` v4.2.2 (patcha o bundle dev do react-dom em serve-time para re-injetar `source` no `jsxDEV` do React 19 — engenhoso, mas frágil por versão); `@locator/babel-jsx` (MIT). SWC tem `jsc.transform.react.development` nativo e esbuild tem `jsx-dev`.
- **Vue 3** (confirmado no core, `runtime-core/src/renderer.ts`): em dev, `def(el, '__vueParentComponent', ...)` no elemento, e o componente tem `__file` (comentado no código como "exposed so that devtools can make use of it") — **só arquivo, sem linha**. O `unplugin-vue-inspector` ≥7 migrou de data-attrs para source locations do render output + source maps do Vite.
- **Svelte** (confirmado v4 e v5): compiler em `dev: true` emite `element.__svelte_meta = { loc: { file, line, column } }`, e o **v5 adiciona `parent: dev_stack`** (pilha de componentes) — o metadata dev mais rico e estável dos 4 frameworks.
- **Angular**: `window.ng.getComponent(el)` em dev (instância, sem source).
- **LocatorJS** (repo `infi-pc/locatorjs`, pacotes npm MIT, mas repo sem LICENSE na raiz): runtime quebrado em React 19 (issues #161/#215/#182 abertas — dependia de `findFiberByHostInstance` + `_debugSource`); o caminho por plugin (`@locator/babel-jsx` + `data-locatorjs-id`) segue válido. **click-to-component** (ericclemmons): morto para React 19 e sem manutenção. Conclusão: o ecossistema convergiu para *ou* data-attrs em build *ou* `_debugStack`+symbolication.

Estratégia em camadas, da mais barata pra mais precisa (cada camada é fallback da seguinte):

- **L0 — Contexto bruto (sempre disponível, qualquer página):** tag, id/classes, seletor único, outerHTML truncado, rect, computed styles filtrados, texto, screenshot do elemento. Suficiente pro agente achar o código por busca (Cursor prova; nosso relatório do impeccable prova com a busca id/classes/tag/texto).
- **L1 — Internals do framework em dev (zero config, requer bridge de main world — §5.2):** React: walk do fiber (`__reactFiber$*`) → nome do componente + cadeia de owners + props serializáveis (padrão stagewise, sobrevive ao React 19) e, para file:line, `_debugStack` + symbolication à la **bippy** (MIT — vendorizar); Vue: `__vueParentComponent` → `type.__name` + `type.__file` (arquivo, sem linha); Svelte: `__svelte_meta.loc` → **arquivo:linha:coluna direto** (v5 dá até a pilha de componentes); Angular: `window.ng.getComponent` (só nome). Tudo dev-only por natureza — em página de produção degrada para L0.
- **L2 — Busca heurística no workspace (zero config):** dado L0+L1, uma busca determinística nossa (grep estruturado por classes/texto/nome de componente no workspace) que devolve top-N candidatos `arquivo:linha` com score — vira link clicável e/ou dica no contexto do agente. Padrão impeccable (`element_ambiguous` → decide o agente).
- **L3 — Instrumentação opt-in por projeto (precisão máxima, determinística):** duas variantes, ambas sem tocar o repo do usuário de forma persistente: (a) **plugin de build dev-only** no padrão `code-inspector-plugin` (MIT, multi-bundler, multi-framework — injeta `data-insp-path/-row/-col`; atributos de DOM são visíveis do isolated world sem bridge, e imunes a mudanças de internals dos frameworks); (b) **RunManager local** (blueprint da era Electron do Onlook, Apache-2.0): pré-processar JSX com Babel injetando IDs efêmeros + índice em memória + watcher com anti-eco + **cleanup no stop** — não exige config de build do usuário, mas escreve nos arquivos durante a sessão. Preferência: (a) quando o projeto usa Vite/Next (config declarada em `.nexus/`, viaja entre PCs); (b) como fallback universal. 

MVP = L0+L1+L2. L3 é a porta para o write-back determinístico da Fase 3.

### 5.4 Write-back

- **Fase 1 (agêntico):** contexto → agente CLI no pane (ou missão Jarvis) edita com as próprias tools. Sem risco novo: é o pipeline atual do Nexus com uma fonte de contexto a mais.
- **Fase 2 (híbrido):** sidebar de estilos com **preview otimista** (comando `design_set_style_preview` aplica num `<style>` gerenciado pelo preload — padrão css-manager do Onlook) e botão **Aplicar** que envia "diff de estilos + contexto do elemento" pro agente (modelo Cursor). O usuário vê o resultado na hora; o agente persiste; o HMR do dev server dele reconcilia; o preload limpa o preview quando detectar a mudança real (MutationObserver).
- **Fase 3 (determinístico, escopo fechado):** para projetos com L3 ativo e Tailwind detectado: estilo→classe (vendorizar o conversor CSS→Tailwind do Onlook, Apache-2.0, ~3.5k linhas standalone) + edição de AST (`@babel/parser` + `retainLines` + prettier como o Onlook, ou `recast`/`magicast` MIT — recast garante round-trip sem diff em código não tocado, o que é **melhor** que a abordagem do Onlook que reformata o arquivo inteiro no primeiro toque). Reorder/insert/delete/text seguem o vocabulário de Actions invertíveis do Onlook (undo/redo). Decisão explícita: **não** perseguir fidelidade universal (Dreamweaver problem) — o determinismo cobre só o vocabulário fechado; o resto cai pro agente.

### 5.5 Dev server do usuário (gap 4)

Sem HMR não há loop "mudou código → página atualiza". Não vamos gerir o dev server do usuário no MVP; vamos **detectá-lo**:

- **Fase 1.5 — dev-server-registry:** scanner passivo do output dos panes PTY (o main já tem ring-buffers de saída em `pane-registry.ts:206-231`) reconhecendo padrões `Local: http://localhost:5173`, `ready on 0.0.0.0:3000` etc. → registro `paneId→url` → ações "Abrir no browser pane" e associação pane-browser↔projeto. Multi-PC: aceitar URLs de rede (a url-policy existente já faz a confirmação de rede privada — `browser-manager.ts:514-543`).
- Extensão futura: tool `nexus_dev_server_status` para o agente saber a URL sem parsing manual.

---

## 6. Licenças e reaproveitamento (due diligence)

| Fonte | Licença | O que podemos fazer |
|---|---|---|
| **Onlook** (repos `onlook` e `desktop`) | **Apache-2.0** (verificada raiz + 19 pacotes + plugin Rust) | Copiar/adaptar livremente em produto proprietário, mantendo copyright/LICENSE/NOTICE nas partes copiadas e declarando alterações. Alvos: `packages/parser` (ids, template-node map, code-edit), preload script (`apps/web/preload/script`), conversor CSS→Tailwind (`packages/utility/src/tailwind.ts` — conferir atribuição do projeto de origem, css-to-tailwind-translator/MIT), matemática de overlay, history manager, `desktop/.../main/run` (RunManager) |
| **recast / magicast** | MIT | Uso livre; magicast é camada de conveniência sobre recast (bom p/ mutações "static-ish"; JSX arbitrário é melhor com recast/babel direto) |
| **bippy** (react fiber utils, usado pelo react-scan) | **MIT** (verificada: LICENSE "Copyright 2024 Aiden Bai") | Vendorizar para L1 React (`getSource` com 4 fallbacks + symbolication). Aviso do próprio autor: usa internals que podem mudar — fixar versão e testar por release de React |
| **code-inspector-plugin** (zh-lx) | **MIT** | Base/referência para L3(a) — data-attrs em build, multi-bundler (webpack/vite/rspack/esbuild), multi-framework; é o sucessor apontado pelo click-to-component |
| **react-dev-inspector** (babel/vite plugins v2) | **MIT** | Alternativa/referência para L3(a) em stacks Babel |
| **stagewise** | **AGPL-3.0-only em tudo que interessa** (raiz, toolbar, plugins de framework, extensão, o IDE `apps/browser`); exceções MIT: `karton` (state-sync/RPC WS), `agent-core`, `agent-shell`; `icons` tem licença própria restritiva | **Não copiar** o código de seleção/toolbar/IDE. Pode-se **espelhar o design** (o schema `SelectedElement`, o padrão de injeção main-world, a UX) — mecanismos e APIs de framework não são copyright do stagewise. `karton` (MIT) poderia ser usado, mas o Nexus já tem IPC próprio |
| **LocatorJS** | pacotes npm declaram **MIT**, mas o repo não tem LICENSE na raiz | Preferir bippy/code-inspector como referência; se usar algo do LocatorJS, citar os pacotes npm (que têm grant MIT explícito) |
| **click-to-component** | LICENSE MIT vs package.json ISC (inconsistente); **sem manutenção** (aponta para code-inspector) | Só valor histórico |
| **impeccable** (skill local) | sem licença explícita verificada | Inspiração de UX/protocolo de eventos; não copiar código sem verificar |
| **Open Design** | metadados inconsistentes (LICENSE MIT vs package.json) | Não é a mesma categoria de feature; ignorar como fonte de código |
| Cursor | proprietário | Só referência de produto/UX |

---

## 7. Riscos e armadilhas (aprendidos do código dos outros)

1. **Componentes instanciados N vezes / listas `.map()`** — mesmo ponto de definição JSX = N nós DOM. Onlook precisa do par `oid/oiid` + resolução recursiva do n-ésimo uso; listas continuam sendo o pior caso (editar 1 = editar todos). *Mitigação:* no MVP isso é problema do agente (que entende semanticamente "o terceiro card"); na Fase 3, copiar a resolução instance-aware do Onlook e recusar edição determinística em `DynamicType.ARRAY` (delegar ao agente).
2. **Sobreviver ao HMR** — o HMR troca nós DOM e mata seleção/preview. Onlook reconcilia via MutationObserver + transplante de atributos; moves exigem `key` forçada no JSX. *Mitigação:* re-seleção por assinatura estrutural (seletor + texto) após mutation; aceitar consistência eventual (debounces em camadas, como Onlook).
3. **Eco de escritores concorrentes** (usuário visual + agente + formatador): anti-eco por hash/`selfModified` (padrões prontos no Onlook). Só relevante na Fase 3 (quando nós escrevemos arquivo).
4. **Poluição do repo do usuário** — decisão já tomada: IDs efêmeros com cleanup (era-Electron), nunca commitá-los. Reformatação estilo "prettier no arquivo inteiro" está **proibida** no nosso write-back (usar recast para diffs mínimos).
5. **CDP debugger vs DevTools** — se usarmos `webContents.debugger` pra qualquer coisa, ele desanexa quando o usuário abre DevTools na view. Por isso CDP não é fundação de nada aqui.
6. **`captureOwnerStack` não funciona em listener próprio** — não desenhar a arquitetura L1 sobre ele (retorna `null` fora de contexto React); fiber walk direto é o caminho.
6b. **Internals de framework são alvo móvel** — o React 19 matou `_debugSource` E `findFiberByHostInstance` de uma vez, quebrando LocatorJS/click-to-component (issues abertas até hoje). *Mitigação:* L1 é sempre *best-effort* atrás da L0/L2 (nunca única fonte); vendorizar a lógica estilo bippy com testes por versão de React; a L3 por data-attributes é imune a isso por construção.
7. **Página third-party/produção** (minificada, sem source) — não prometer mapeamento; entregar o modo "inspiração/clonagem" (screenshot + outerHTML + styles → agente recria no projeto). É inclusive um caso de uso vendável.
8. **Instabilidade inerente do drag estrutural** — o próprio Cursor não consegue mapear reorders complexos de volta (relato jan/2026). Manter drag na última fase, com expectativa honesta (grids/flex simples primeiro, padrão stub do Onlook).
9. **Segurança**: manter o modelo atual — preload só executa comandos da allowlist (`browser-preload.ts:11-17`), nunca `executeJavaScript` arbitrário do agente na página; contexto extraído passa pela redação de segredos existente (`redactBrowserText`); allowlist de navegação continua valendo (lição do Cursor: origin allowlist best-effort é um risco conhecido).
10. **Autorização** — implementada no main com ownership da janela, scope exato,
    revalidação após awaits e PREVC para o caminho que injeta contexto em agente.

---

## 8. Fases propostas (roadmap)

**Fase 0 — Fundações (pré-requisitos):**
- ✅ Authz por janela/projeto/checkout e PREVC pinado em testes de autoridade.
- Canal de eventos page→main no preload (`browser:design-event`).
- Comando `design_enable/disable` + picker básico (hover highlight + click select) num ShadowRoot fechado.
- Spike da bridge de main world (`webFrame.executeJavaScript` sob `sandbox: true`) — pré-requisito da L1 (pendência §10.5).
- *Critério de aceite:* selecionar elemento em qualquer página e ver o contexto L0 no log; ler `__reactFiber$*` de uma página React em dev via bridge.

**Fase 1 — MVP "Select → Agente" (paridade Cursor 2.0):**
- Extração de contexto L0+L1 (React/Vue/Svelte dev) + L2 (busca heurística com candidatos arquivo:linha).
- Tool `nexus_design_selection_get` + botão "enviar seleção pro agente" (injeta contexto formatado no pane PTY da missão ativa; e disponível pro Jarvis por voz via o caminho `window.nexus.mcp.invoke` já existente).
- Screenshot do elemento anexado ao contexto.
- *Critério de aceite:* "selecionei o botão → falei 'deixa ele verde' → agente editou o arquivo certo → HMR atualizou a página".

**Fase 1.5 — Dev-server awareness:**
- Registry por scan do output PTY + ação "abrir no browser pane"; associação projeto↔pane browser.

**Fase 2 — Design sidebar (paridade Cursor 2.2):**
- Sidebar no IDE (React) com computed styles editáveis do elemento selecionado (position/spacing/typography/cores/temas).
- Preview otimista via `<style>` gerenciado no preload; **Aplicar** = diff de estilos → agente.
- Anotações estilo impeccable (comentário ancorado no elemento) como enriquecimento do prompt.
- *Critério de aceite:* ajustar padding/cor com preview instantâneo e aplicar sem tocar teclado no código.

**Fase 3 — Write-back determinístico + estrutura (além do Cursor, território Onlook):**
- L3 opt-in (RunManager-style, IDs efêmeros + índice; cleanup garantido).
- CSS→Tailwind (vendor Onlook) + AST edit com recast p/ estilos; texto inline (contenteditable simples antes de ProseMirror); delete/insert; undo/redo por Actions invertíveis.
- Drag/reorder com stub geométrico (flex/grid simples), determinístico e sem
  persistir keys sintéticas no JSX.
- *Critério de aceite:* sessão de design de 10 min num projeto Next+Tailwind sem intervenção manual no código, com undo funcionando.

**Fase 4 — Polimento/expansão:** multi-seleção, breakpoints/responsivo, modo "clonar third-party", canvas multi-frame (o IDE já tem canvas `@xyflow`), colaboração multi-PC (estado de sessão de design por projeto em `.nexus/`).

**Dependências externas por fase:** F0–F2 não tocam o projeto do usuário (zero config). F3 exige opt-in por projeto e é onde importamos as peças do Onlook.

---

## 9. Requisito multi-plataforma / multi-PC (checklist de conformidade)

- [x] `WebContentsView` + preload + IPC: idênticos em macOS/Windows/Linux (nenhuma API nativa de SO no design).
- [x] Overlay em CSS pixels dentro da página → imune a DPI scaling do Windows/Linux.
- [x] Nada de caminho hardcoded: config por projeto em `.nexus/` (viaja no repo entre PCs); estado de máquina em `app.getPath('userData')`.
- [x] Dev server pode ser remoto (outro PC da rede): detecção aceita URLs não-localhost com a confirmação de rede privada já existente; write-back sempre no workspace local (limitação documentada: projeto precisa estar na máquina onde o Nexus roda — sync de workspace entre PCs é tema separado).
- [ ] Validar `@parcel/watcher`/watchers (se Fase 3) nos 3 SOs — pontos históricos de dor no Linux (inotify limits) e Windows (case-insensitive paths).

---

## 10. Pendências de pesquisa

1. ~~stagewise: licenças + extração de contexto + payload~~ **RESOLVIDO** (ver §2.3, §6; clones das 3 eras no scratchpad da sessão de pesquisa).
2. ~~Confirmar em código: Vue `__vueParentComponent`/`__file`, Svelte `__svelte_meta.loc` v4/v5, bippy, plugins data-attrs~~ **RESOLVIDO** (ver §5.3; tudo confirmado em código-fonte dos cores).
3. Benchmark rápido do custo de: fiber walk em página grande; busca heurística L2 no workspace (usar índice? ripgrep?).
4. Decidir UX do "modo design" (botão por pane vs modo global) com protótipo de baixa fidelidade.
5. ~~Prototipar a bridge de main world~~ **RESOLVIDO (Fase 0.4, spike PASS)**: `webFrame.executeJavaScript` funciona sob `sandbox: true` + `contextIsolation: true` na config exata do browser-manager; isolated world é cego para `__reactFiber$*` e o main world lê fiber + nome de componente. Spike re-executável em `scripts/spikes/main-world-bridge/`.
6. Menor: licença exata do repo `vite-plugin-react-click-to-component` (não é peça necessária do plano; só completude).

---

## Apêndice A — Fontes primárias

- Cursor: blog "browser-visual-editor" (11/dez/2025), changelog 2.0 (29/out/2025), docs "agent/tools/browser" — claims verificadas adversarialmente 3-0.
- Onlook: engenharia reversa dos repos `onlook-dev/onlook` (web, atual) e `onlook-dev/desktop` (era Electron) — relatório completo com caminhos de arquivo no histórico desta pesquisa.
- stagewise: engenharia reversa das 3 eras do repo `stagewise-io/stagewise` (toolbar jul/2025, CLI set/2025, IDE Electron jul/2026) com caminhos de arquivo e trechos; licenças conferidas nos LICENSE/package.json de cada pacote.
- impeccable live: inspeção direta da skill local (`~/.claude/skills/impeccable/reference/live.md` + scripts).
- Nexus: mapeamento com referências `arquivo:linha` (relatório no histórico desta pesquisa).
- React: PR facebook/react#28265 (remoção de `__source`); diff do tipo Fiber v18.3.1 vs 19.2.x (`_debugSource` → `_debugStack`); CHANGELOG 19.1 (`captureOwnerStack`); remoção de `findFiberByHostInstance` do hook devtools.
- Vue core (`runtime-core`: `__vueParentComponent`, `__file`), Svelte 4 (`add_location` → `__svelte_meta`) e Svelte 5 (`dev/elements.js`, `__svelte_meta` + `parent: dev_stack`) — lidos no código-fonte.
- bippy (`getSource` com 4 fallbacks + symbolication, MIT), code-inspector-plugin (MIT), react-dev-inspector v2 (MIT), LocatorJS (issues #161/#215/#182 sobre React 19), click-to-component (issues #99/#104).
- Electron: docs oficiais (`webview` desencorajado; `BrowserView` deprecado no 30; `webContents.debugger` como transporte CDP; detach ao abrir DevTools).

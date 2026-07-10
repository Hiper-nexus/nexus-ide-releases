# VISUAL-EDIT-001 — Edição visual no browser pane ("Live Design", estilo Cursor/Onlook)

> **Implementado e integrado à v0.12; hardening de release concluído.** Estudo de viabilidade completo (pesquisa
> profunda: Cursor + engenharia reversa Onlook/stagewise + mapeamento do Nexus) em:
> **`docs/superpowers/specs/2026-07-10-edicao-visual-live-browser-design.md`** (fonte canônica).
> Este ticket é o resumo executável "para fazer em breve".

## O que é

Selecionar/manipular elementos do site do usuário direto na aba do browser embutido e as
mudanças virarem código-fonte. Paridade com Cursor 2.0/2.2 (Browser + Visual Editor) nas fases
1–2; território Onlook (write-back determinístico + drag) na fase 3.

## Veredito do estudo

- **Viável.** O Nexus já tem ~40% da fundação: `WebContentsView` + preload com automação de DOM
  (refs opacas, read/inspect/click/fill), MCP embutido, agentes CLI em panes, tools de arquivo
  com scope. Falta: picker/overlay, contexto rico, mapeamento DOM→código, loop de write-back.
- **Write-back agêntico primeiro** (modelo Cursor, validado em produção — o agente CLI no pane
  PTY edita o código a partir do contexto da seleção). Determinístico (AST + CSS→Tailwind) só na
  fase 3, com vocabulário fechado.
- **Multi-plataforma por construção** (requisito do produto: macOS/Windows/Linux + multi-PC):
  tudo Chromium/preload, coordenadas em CSS px, config por projeto em `.nexus/`, zero API nativa
  de SO. Dev server pode ser remoto (url-policy existente cobre).

## Pré-requisitos (Fase 0) — fazer primeiro

- [x] **Authz multi-projeto fechada no main**: browser panes e eventos são
      vinculados ao `WebContents` e ao `ProjectExecutionScope`; o push para um
      agente exige o mesmo checkout, missão viva, contrato atual e PREVC em
      `execution`. Troca de workspace invalida callbacks e sessões.
- [x] Canal de **eventos** page→main no preload: `browser:design-event`
      (shared/browser-design.ts, validação Zod estrita em browser-design-schema.ts, store por
      pane em design-session.ts com subscribers; sender resolvido a um browser view registrado;
      sessão limpa em did-navigate e destroyBrowser). TDD: design-session.test.ts (10 testes).
- [x] Comandos `design_enable/disable` + picker em **ShadowRoot fechado**
      (browser-design-mode.ts no preload: hover highlight+label, clique seleciona com supressão
      do handler da página, Escape sai; contexto L0 com redação de segredos e refs e<N>
      compartilhadas com inspect/click/fill; setBrowserDesignMode() no browser-manager).
      TDD: browser-design-mode.test.ts (11 testes JSDOM, payload validado contra o schema Zod).
- [x] **Spike da bridge de main world — PASS** (Electron real, webPreferences idênticas ao
      browser-manager): `webFrame.executeJavaScript` FUNCIONA sob `sandbox:true` +
      `contextIsolation:true`; isolated world confirmado CEGO para `__reactFiber$*`
      (fiberKeys: []); main world lê o fiber e o walk resolve o nome do componente
      (`SaveButton`). Fallback contents.executeJavaScript não foi necessário.
      Re-executável: `npx electron scripts/spikes/main-world-bridge/spike-main.mjs`.
- Aceite: ✅ pipeline picker→evento→ingest→getLastSelection coberto por testes (JSDOM +
  schema do main); ✅ fiber de página React dev lido via bridge em Electron REAL (spike PASS).
  Pendente para Fase 1: exercitar o loop no IDE completo rodando (preload compilado).

## Fases (resumo; detalhe no spec §8)

### F1 — MVP "Select → Agente" (paridade Cursor 2.0)

- [x] `frameworkHints` no contrato/schema Zod estrito (react/vue/svelte/angular; componentName,
      ownerChain≤10, propKeys — só NOMES de props, source file:line quando o framework emite).
      TDD: design-session.test.ts (describe "frameworkHints").
- [x] **L1 — bridge de main world** (`browser-framework-introspect.ts`): probe read-only
      injetado via `webFrame.executeJavaScript` (padrão do spike 0.4), elemento localizado por
      atributo-nonce transitório (removido em `finally` — nada persiste no DOM do usuário).
      React fiber walk (`__reactFiber$*` → componente+owners+propKeys), Vue
      (`__vueParentComponent.type.__name/__file`), Svelte (`__svelte_meta.loc`), Angular
      (`ng.getComponent`). Sanitização no preload + Zod no main; timeout 250ms; falha degrada
      p/ L0 sem perder a seleção. TDD: browser-framework-introspect.test.ts (11) +
      browser-design-mode.test.ts (describe L1).
- [x] **L2 — busca heurística no workspace** (`design-code-search.ts`): walk fs puro bounded
      (skip node_modules/.git/build; nunca segue symlink), sinais ponderados (definição de
      componente > id > filename > texto > uso > classe) → top-5 `arquivo:linha` com score e
      razões; `queryFromSelection` deriva a query (texto sensível nunca vira query). TDD:
      design-code-search.test.ts (6).
- [x] **Tool MCP `nexus_design_selection_get`** (`tools-design.ts`, padrão
      McpToolDef+authorizePaneRef, agregada em tools.ts): seleção L0+L1 + candidatos L2 +
      screenshot de elemento opcional. TDD: tools-design.test.ts (5).
- [x] **Screenshot de elemento**: `captureBrowserScreenshot(paneId, {clip})` com
      `clampScreenshotClip` (CSS px = unidade do capturePage, multi-DPI safe; fora da viewport
      cai p/ captura cheia; padding 8px). TDD: screenshot-clip.test.ts (6).
- [x] **Ação "enviar seleção pro agente"** (`design-send.ts` + canal `browser:designSend`):
      formata o contexto (`design-context-format.ts`, caps por seção, teto 6k chars) e injeta
      no PTY do pane alvo via bracketed paste (`injectPastedPrompt`, mesmo padrão do kickoff de
      missão). TDD: design-send.test.ts (5) + design-context-format.test.ts (4).
- [x] **UI**: botão Design Mode (◎) + barra de seleção no BrowserPane (`BrowserDesignBar.tsx`)
      — toggle espelhado por eventos (Esc na página desliga o botão), label da seleção,
      instrução opcional, alvo entre panes cli-agent. Canais novos `browser:designMode`/
      `browser:designEvent`/`browser:designSend` (owner-checked) + `window.nexus.browser`.
      TDD: BrowserDesignBar.test.tsx (6).
- [x] **ACEITE no IDE real** (evidência abaixo em "Evidência F1"): React dev (Vite) num browser
      pane, Design Mode ligado, clique no elemento → `nexus_design_selection_get` devolveu L1
      real (react/SaveButton/owners) + L2 com o arquivo certo em 1º (score 142) + screenshot do
      elemento; "enviar pro agente" injetou o contexto no pane do claude → claude editou o
      arquivo certo.

### F1.5 — Dev-server awareness

- [x] Scanner passivo do output PTY (`dev-server-detect.ts` + `dev-server-registry.ts`,
      wired nos mesmos taps dos ring-buffers em pane-registry): URLs locais/privadas
      (Vite/Next/CRA/genérico), ANSI-safe, carry de fronteira de chunk, dedupe, cap,
      normalização 0.0.0.0→localhost, URLs públicas ignoradas; registro paneId/sessionId→url
      com limpeza no exit + `getDevServerForPane` p/ tools futuras. TDD:
      dev-server-detect.test.ts (7) + dev-server-registry.test.ts (6).
- [x] Ação "abrir no browser pane": push `devserver:detected` → chip `🌐 host:port` na
      toolbar do pane (`DevServerChip.tsx`); abre via about:blank + load — a confirmação
      de rede privada existente continua valendo. TDD: DevServerChip.test.tsx (5).
- [x] ACEITE (IDE real, evidência em TASK/evidence/visual-edit-001/): `npx vite` num pane
      shell do workspace react-demo → chip "🌐 localhost:5201" apareceu na toolbar
      (`f15-devserver-chip.png`); clique abriu browser pane com a página React em
      http://localhost:5201/ (`f15-browser-pane-open.png`; target CDP confirmou
      "React Demo — VISUAL-EDIT-001 :: http://localhost:5201/").

### F2 — Design sidebar (paridade Cursor 2.2)

- [x] Computed styles do elemento selecionado, editáveis (espaçamento/tipografia/cores &
      borda) na `DesignSidebar` (toggle ≡ na design bar do BrowserPane). Estado de seleção
      por pane numa store única do renderer (`design-selection-store`) — sidebar aberta
      DEPOIS do clique mostra a seleção corrente (bug pego pelo aceite real e pinado em
      teste). TDD: DesignSidebar.test.tsx (6) + BrowserDesignBar.test.tsx migrado.
- [x] Preview otimista via `design_set_style_preview`/`design_clear_style_preview`
      (browser-style-preview.ts, espelho do css-manager do Onlook): `<style>` gerenciado com
      UMA regra `!important` por seletor, MESCLA por propriedade (edições campo-a-campo
      acumulam — bug pego pelo aceite real e pinado em teste), valores validados contra
      escape de declaração/regra e `url()`, e MutationObserver que derruba o preview do
      seletor quando a mudança REAL chega (HMR muda style/class ou substitui o nó).
      TDD: browser-style-preview.test.ts (8) + comandos no run() (browser-design-mode.test).
- [x] "Aplicar" envia `styleDiff` {from,to} + contexto pro agente (canal designSend; o
      formatter instrui "persista exatamente estas mudanças"); "Reverter" limpa o preview.
- [x] ACEITE (IDE real, evidência em TASK/evidence/visual-edit-001/): padding-top 24px e
      background #9333ea com preview INSTANTÂNEO na página (computed style confirmado via
      CDP; sidebar em `f2-sidebar-preview.png`); Aplicar com diff paddingTop 28 +
      backgroundColor #0d9488 → claude persistiu exatamente essas props no elemento
      selecionado (`f2-claude-persisted-diff.txt`) e o HMR entregou.

### F3 — Write-back determinístico + drag (opt-in `.nexus/`)

> Gate de release 0.12: a implementação e o aceite abaixo permanecem válidos
> no ambiente de desenvolvimento, mas o aplicativo empacotado registra o
> write-back com `allowSourceMutation: false`. Nenhuma mutação direta/reorder
> fica alcançável na distribuição; seleção, preview e “Aplicar → agente”
> permanecem habilitados.

- [x] Instrumentação L3 (`design-instrument.ts`, blueprint RunManager era-Electron do Onlook):
      IDs efêmeros por range-insert em todo JSX (bounded, sem symlink), índice id→arquivo:linha
      em memória, anti-eco por hash (isSelfWrite/noteSelfWrite) + watcher fs.watch por arquivo
      com debounce (`design-writeback-service.ts`), cleanup byte-perfeito no stop. Opt-in por
      projeto em `.nexus/design.json` (default DISABLED). TDD: design-instrument.test.ts (6) +
      design-writeback-config.test.ts (3) + design-writeback-service.test.ts (4).
- [x] Estilos→Tailwind: conversor do Onlook vendorizado (Apache-2.0, 3.5k linhas, LICENSE +
      NOTICE em `src/vendor/onlook-css-to-tailwind/`) com facade por propriedade + conflito
      por stem (twMerge-lite); AST via recast SÓ para edições estruturais — edições de literal
      (className/valores/texto) são RANGE edits byte-cirúrgicos no fonte (recast reimprime o
      subtree e violaria o minimal-diff). TDD: css-to-tailwind.test.ts (4) +
      design-code-edit.test.ts (14).
- [x] Texto inline (nó de texto único; filhos compostos recusados → agente); delete/restore;
      duplicate (cópia sem id, re-tagueada no refresh); drag/reorder com stub geométrico no
      overlay (eixo de fluxo por spread de midpoints, flex/grid de fluxo único; evento
      'reorder' Zod), sem persistir keys sintéticas nem alterar a semântica React. TDD:
      browser-design-drag.test.ts (3) + describe drag no browser-design-mode.test.ts.
- [x] Undo/redo por Actions invertíveis (`design-actions.ts`, modelo history do Onlook): cada
      execução devolve o inverso semântico; undo empilha no redo; apply novo limpa o redo.
      TDD: design-actions.test.ts (5). UI na DesignSidebar (Aplicar direto/texto/↑↓/⧉/🗑/
      desfazer/refazer/iniciar/parar) + IPC design:* re-validado por Zod.
- [x] ACEITE (IDE real, Next 14 + Tailwind 3 dev em localhost:5210 — evidências em
      TASK/evidence/visual-edit-001/): sessão completa sem editar código à mão — (1)
      cor+padding via "Aplicar direto": diff de 1 LINHA trocando `bg-amber-50` →
      `bg-[#ecfdf5] pt-[32px]` (conflito por stem removeu a cor antiga, `p-4` preservada);
      (2) texto "Card Alfa"→"Card Prime" (e recusa correta no <article> composto); (3)
      reorder dos 2 cards; (4) desfazer restaurou ordem no ARQUIVO
      e na página viva (fast refresh); (5) stop limpou 100% dos `data-nexus-id` e as edições
      persistiram (`f3-final-diff.txt`, `f3-page-final.jsx.txt`, `f3-page-final.png`).
      Quirk conhecido (cosmético): remover o id de um opening element multi-linha criado
      pelo reorder deixa uma linha em branco no JSX.

### F4 — Polimento (escopo FECHADO)

- [x] Multi-seleção (shift+click): acumula/toggle no picker (cap 8), flag `additive` no
      contrato Zod, set por pane em design-session + store do renderer, badge `⧉ N` na
      design bar, extras listados no push pro agente e `selections` na tool
      `nexus_design_selection_get`. TDD em todas as camadas.
- [x] Breakpoint preview (375/768/1440/total): estreita a própria WebContentsView centrada
      no slot (viewport REAL da página; só estreita — slot menor que o breakpoint é no-op).
      Math pura testada (`viewport-override.ts`); botões na design bar.
- [x] Modo "clonar elemento third-party": botão "recriar no projeto" envia `intent: 'clone'`
      (contexto+screenshot, SEM busca L2 — sem promessa de mapeamento de fonte); o
      formatter instrui recriação seguindo os padrões do projeto e sem baixar assets.
- [x] Docs: ARCHITECTURE.md §E.2.1 (subsistema de design + tool nova na tabela E.2) e
      CHANGELOG ("Não lançado — Live Design").
- [x] ACEITE (IDE real, evidências em TASK/evidence/visual-edit-001/): (1) shift+click em 2
      cards do next-demo → badge "⧉ 2"; (2) breakpoint 375 → `window.innerWidth` da página
      foi 472→375→restaurado (`f4-breakpoint-375.png`); (3) clonar o h1 do example.com →
      claude criou `app/components/ExampleDomain.jsx` seguindo as convenções do projeto,
      sem assets remotos, e verificou o render no dev server
      (`f4-cloned-component.jsx.txt`, `f4-ide-design-bar.png`). Feedback de UX do usuário
      durante o aceite corrigido na hora: breakpoints em linha única (barra não quebra em
      telas estreitas) e botões com rótulos claros ("→ agente", "recriar no projeto").

## Evidência F1 (aceite no IDE real, 2026-07-10)

### Hardening adicional para release

- [x] IDs autorais preservados; cleanup remove somente atributos pertencentes
      à sessão Nexus.
- [x] JS/JSX reparsado, propriedades CSS validadas e conteúdo escapado.
- [x] PTY recusa C0/C1/ESC/CR e bracketed-paste injection.
- [x] CAS SHA-256, fila por sessão, rename atômico, `O_NOFOLLOW`, contenção de
      path e invalidação de undo diante de edição externa.
- [x] Eventos exigem `Event.isTrusted`, generation UUID e eventId single-use.
- [x] Form controls/subárvores sensíveis são podados; conteúdo de página vira
      JSON delimitado e explicitamente não confiável.
- [x] Sessões simultâneas isoladas por projeto/checkout e janela; shutdown
      aguarda cleanup.

Fluxo executado no NexusIDE dev de verdade (npm start, CDP `NEXUS_REMOTE_DEBUG` para o
driving), com projeto React+Vite dev servindo em `http://localhost:5199/` dentro do
workspace ativo e um pane `claude` ao lado:

1. `nexus_browser_open` → browser pane `pane-9ea1f74c` com o app React.
2. Botão ◎ (Design Mode) na toolbar do pane → picker ativo na página.
3. Clique no `<button id="save-cta">` → seleção com **L1 real via bridge de main world**
   (`frameworkHints: react / SaveButton / owners [SaveButton, App] / propKeys [label]`) e
   **L2 com o arquivo certo em 1º**: `src/components/SaveButton.jsx:3` (score 142 —
   component+id+class+filename). Payload completo: `TASK/evidence/visual-edit-001/f1-selection-get.json`.
4. Screenshot do elemento clipado (168×54): `f1-element-screenshot.png`.
5. Instrução "Mude o background do botão selecionado para verde #16a34a" + botão →🤖
   ("contexto enviado ✓") → contexto injetado no PTY do claude (bracketed paste).
6. Claude editou o arquivo certo com diff mínimo (`background: '#2f6ae0'` → `'#16a34a'`
   em `src/components/SaveButton.jsx`): `f1-claude-diff.txt`.
7. HMR do Vite aplicou — página com o botão verde: `f1-page-after-hmr.png`.
   UI do IDE com o pane + design bar: `f1-ide-browser-pane.png`.

Nota de comportamento observada (esperada, spec §7.2): full reload do dev server
(re-otimização de deps do Vite) navega o documento → `did-navigate` limpa a sessão de
design e o picker desarma; a UI segue o estado real via eventos de modo.

## Seams de integração no código atual (do mapeamento)

- Instrumentação in-page: `src/preload/browser-automation.ts` (novos casos no `run()` switch
  `:503-510`) + contrato `src/shared/browser-automation.ts:11-16` + allowlist
  `src/preload/browser-preload.ts:11-17`.
- Main-side: `src/main/browser/browser-automation-runtime.ts:57-93`,
  `browser-manager.ts:595-670`.
- Tools MCP novas: `tools-design.ts` no padrão `McpToolDef` + `authorizePaneRef`, agregado em
  `src/main/orch/tools.ts:21-32`.
- UI: `BrowserPane.tsx` (toolbar do pane) + novos `BROWSER_CHANNELS` em `src/shared/channels.ts`
  + handlers em `browser-manager.registerBrowserIpc` `:725-799`.

## Regras de licença (due diligence feita)

- **PODE copiar/adaptar (com NOTICE):** Onlook (Apache-2.0 — parser/ids/code-edit, preload
  script, conversor CSS→Tailwind ~3.5k linhas, overlay math, history, RunManager); bippy (MIT,
  `getSource` fiber React 19); code-inspector-plugin (MIT); react-dev-inspector (MIT); recast/
  magicast (MIT).
- **NÃO copiar:** stagewise (seleção/toolbar/IDE = AGPL-3.0-only; só espelhar o *design* — ex.
  o schema `SelectedElement`); Cursor (proprietário, só referência de UX).

## Armadilhas conhecidas (não redescobrir — spec §7)

Componentes instanciados N vezes / listas `.map()` (par oid/oiid do Onlook); sobreviver ao HMR
(MutationObserver + transplante de attrs; reorder determinístico sem keys sintéticas); eco de escritores
concorrentes (hash/selfModified); NUNCA persistir data-attrs no repo do usuário; CDP
`webContents.debugger` desanexa quando DevTools abre (por isso CDP não é fundação);
`captureOwnerStack` retorna null em listener próprio; React 19 matou `_debugSource` +
`findFiberByHostInstance` (L1 é best-effort, L3 por data-attrs é imune).

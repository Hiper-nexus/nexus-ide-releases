# Revisão: kit de UI, Jev/Clef, navegador e desempenho de missão (22/10/2026)

Base: `main` em `1bff3b71d` (0.76.409); app instalado 0.76.407. Revisão somente leitura:
12 frentes (94 agentes), cada achado médio ou maior passou por verificador cético.
Nenhum arquivo do produto foi alterado. Severidades abaixo já são as **corrigidas pelo
verificador**. "Medido" = rodei algo; "lido" = só código.

## 1. Veredito

| Pergunta | Resposta |
|---|---|
| Kit de UI operacional e disponível? | **Parcial.** Funciona no macOS ponta a ponta. No Windows nenhum comando roda (lido, não testado em Windows real). Nenhum agente real o usou ainda. |
| Jev/Clef sabem a hora de usar? | **O juiz sabe; o fluxo não chega nele.** Jev real (jev-1.13.0) acertou "pede kit?" nas 22 tarefas claras (precisão 1,00, recall 1,00, 78 chamadas). A skill e a carta mandam o agente por um caminho que usa só a heurística offline. |
| Motor ok? | Motor sim (498 testes, 3 instalações reais). As bordas não: Windows, projeto sem `components.json`, saída cortada, candidatos. |
| Navegador? | OK para páginas comuns; falha com a UI que o kit gera (menus Radix, iframe, `<select>`); não abre dev server local. |
| Missão na melhor forma? | **Não.** O PR #159 (0.76.407–409) resolveu o trabalho repetido. Sobra cerimônia igual para qualquer diff e espera por rodadas de LLM. |

## 2. Medições (reproduzíveis)

- Testes focados: ui-kit + `tools-ui-kit-read-only` = 18 arquivos, 498 testes verdes; painel/IPC 78+34 verdes; navegador 17 arquivos, 283 verdes; portão visual 235 verdes.
- Instalações reais no Mac (projeto Vite de teste, `XDG_CONFIG_HOME` isolado, `license.json` real intocado): shadcn `button` 7,3 s; BoardUI `stat-cards` 4,7 s; `@shadcnuikit/pricing1` 4,0 s. Cache de fonte: 1,2 s / 3,1 s → ~1 ms.
- Busca shadcn: 200 itens (1,2–2 s morno). BoardUI grátis: 69. `@shadcnuikit`: 1.228 itens (índice público, sem token); `@shadcn` 471.
- Jev real: 0,2–0,4 s por decisão. 26 tarefas × 3 repetições. Faixas de noul: UI 0,66–0,95; sem UI 0,04–0,49 (margem de só 0,06 até o limiar 0,6 no pior caso: "transform the CSV import" 0,49; falso positivo "ajustar cor do botão primário" 0,87).
- Heurística offline: precisão 0,556, recall 0,833 nas 22 claras; marca 8 de 10 tarefas sem UI como UI.
- Uso real nesta máquina: diário do Jev com 2.925 linhas (25/09–21/10), **0 de `uiKitPick`**; 0 chamadas `nexus_ui_kit_*` em 17 bancos; kit chegou ao app instalado hoje 09:15 e desde então zero spawn de pane. Navegador: 147 chamadas reais em 4 dias (132 ok, 15 erro); clique p50 0,49 s.
- Missão: `npm run test:mission-e2e` 2/2 em 59,75 s; pane só 7,24 s vs missão 11,47 s (+4,2 s, 1,58×). Spawn de helper via MCP p50 5,1 s / p90 12 s (worktree: git 2,3 s + CoW 3,1 s). Spawn→1º handoff p50 11,1 min / p90 54,9 min (n=25). 3 missões da semana terminaram em `blocked` e foram removidas.
- Shadcn CLI 4.22.1: `--json` existe; prompts do `add` sem `components.json` e do `init` sem preset **não respeitam `--yes`** (medido com `prompts` 2.4.2 e stdin `/dev/null`: trava).

## 3. Os 6 itens P0 (briefing para implementar)

Cada um: onde, problema, correção sugerida, teste a escrever primeiro.

### P0-1 Windows: `npx.cmd` com `shell:false` dá EINVAL (alto, confirmado por leitura)
- Onde: `src/main/ui-kit/ui-kit-cli.ts:441-464` (`resolveNpxCommand`) e `:561-587` (spawn); `src/main/ui-kit/ui-kit-mcp-call.ts:183-201` (mesmo spawn para o MCP do BoardUI); getdesign-cli-source tem o mesmo padrão.
- Problema: Electron 43.7.4 = Node 24.21.0, que recusa `.cmd`/`.bat` sem shell. O repo já registra o mesmo em `codex-cli-version.ts:58-63` (F-668/F-687). npm do Windows não traz `npx.exe`.
- Correção: reutilizar `src/main/adapters/windows-npm-shim.ts` (`windowsNpmShimSpawn`, `windowsCliProbeLaunch`): a partir do `npx.cmd` achar `node.exe` + `node_modules/npm/bin/npx-cli.js` do mesmo diretório e rodar `node.exe npx-cli.js …` sem `cmd.exe`. Fallback: `cmd.exe /d /s /c` com caminho entre aspas e `windowsVerbatimArguments`. Aplicar nos dois spawns.
- Teste primeiro: com `platform:'win32'` e `exists` injetado, `resolveNpxCommand`/novo resolvedor devolve `{command: node.exe, args:[npx-cli.js,…]}`; nunca devolve `.cmd` com `shell:false`.

### P0-2 `add`/`recipe`/`init` sem `components.json` travam 300 s (alto)
- Onde: `src/main/orch/tools-ui-kit.ts` (~681 e handlers add :335, recipe :416, run :527); `UI_KIT_WRITE_TIMEOUT_MS = 300000` em `ui-kit-cli.ts:48`. Codex corta a tool em 120 s (`cli-mcp-inject.ts:94/117`).
- Problema: projeto React novo (caso mais comum) → prompt interativo ignora `--yes` → `TIMEOUT` sem motivo. `init` sem preset/itens/`--defaults` abre selects (`Te()`/`qe()`).
- Correção: antes de `add`/`recipe` do shadcn, checar `components.json` na raiz de execução; se ausente, devolver na hora erro acionável (`rode nexus_ui_kit_run {command:'init'}` ou equivalente com `--defaults`) ou fazer o init sozinho. No `init` do agente, sempre passar `--defaults`/preset. Opcional: serializar escrita por projeto e repassar `invocation.signal`.
- Teste primeiro: projeto temporário sem `components.json` → `add` devolve erro com `hint` em < 1 s, sem spawn.

### P0-3 Skill e carta mandam `catalog → add(slugs)`; o Jev nunca decide (médio, confirmado)
- Onde: `assets/skills/ui-kit/SKILL.md:40-48,55` (+ manifesto gerado `src/main/orch/ui-kit-manifest.ts`), `src/main/orch/design-charter.ts:31`, `worker-handoff-contract.ts:228`; hint de `nexus_ui_kit_catalog` em `tools-ui-kit.ts:182-225`.
- Problema: `catalog({task})` é read-only e só usa heurística offline (`offlineRuleOnly`). O único call site de `pickUiKit` é `add({task})` sem `items` (`ui-kit-install-target.ts:163`).
- Correção: trocar para "sem saber o slug, use `nexus_ui_kit_add({task})`; com slug, `{items}`; `catalog` só para listar". Atualizar skill e carta; `node scripts/bundle-skills.mjs` e commitar o manifesto. Mesma mudança no recibo do catálogo (apontar `add({task})`). Corrigir também o caminho "Settings → UI kits" para "Configurações › Biblioteca › Kits de UI" (ui-kit-service.ts:588,1461; ui-kit-install-view.ts:131,139; tools-ui-kit.ts:453,613,630; SKILL.md:71,96). Cuidado com os tetos: `DOCTRINE_BASE` < 2048 bytes e `MAESTRO_STANDING_DOCTRINE` < 1500 caracteres; a carta é outro arquivo, mas confira `design-charter-ui-kit.test.ts`.
- Extras de mesma natureza (P1): repassar `sessionId/missionId/signal` ao `pickUiKit` (hoje escapa do orçamento de decisão); linha do kit independente do toggle `designPro`; uma frase no `uiNote` do Maestro sugerindo `nexus_ui_kit_recipe` para superfície inteira.
- Teste primeiro: `design-charter-ui-kit.test.ts` e teste do manifesto exigem `nexus_ui_kit_add` com `task` no passo de descoberta; `bundle-skills` sem diff.

### P0-4 `@shadcnuikit` (1.228 itens) invisível no add por tarefa e nas receitas (alto, confirmado)
- Onde: `src/main/ui-kit/ui-kit-catalog.ts:153-168` (`liveCandidates`), chamado por `tools-ui-kit.ts:429` (receita) e `ui-kit-install-target.ts:154-163`.
- Problema: sem query, busca `['@shadcn','@shadcnuikit']` num único `--limit 200`; o CLI concatena na ordem e corta; os 200 são todos `@shadcn` (declarando ou não o namespace). Resultado: pricing/hero/landing → "Nothing in the catalog fits" (existem 20 `pricing*` e 26 `hero*` pagos). O CLI resolve `@shadcnuikit` pelo diretório público sem declaração.
- Correção (3 partes): (1) buscar cada registry não-padrão numa execução própria, sem dividir o limit; (2) passar `--query` com as palavras da tarefa (`taskAffinityWords`) em 1–2 buscas pequenas por kit; (3) paginar com `--offset` e `limit ≤ 50` (50 itens = 20.587 bytes). Desprezar `category: 'example'` no `rankForTask`. Relacionado (P0-4b, mesmo arquivo de risco): a saída `--json` > 64 KiB chega cortada em 65.536 bytes no macOS/Windows porque o CLI faz `console.log` + `process.exit()` com pipe assíncrono; páginas pequenas contornam; alternativa: capturar para arquivo temporário. Teste com saída de 65.536+ bytes.
- Recuperação do top12 do Jev (`ui-kit-pick.ts:122`): em 6/12 pedidos de UI o item certo existe e não entra nas 12 vagas (tabs, alert-dialog, sidebar, empty, sonner, chart-line). Normalizar acento/plural nos dois lados e ampliar antes do corte de 12.
- Teste primeiro: `liveCandidates` com dois registries e runner falso devolve itens dos dois; "pricing page" retorna candidato `@shadcnuikit/pricing*`.

### P0-5 Recibo "Instalado" mente (alto, parcial)
- Onde: `src/main/ui-kit/ui-kit-install-view.ts:80` (painel), `:115-139` (agente), `tools-ui-kit.ts:478-484` (`installed: result.ok` na receita), `ui-kit-service.ts:228-239,1428`.
- Problema: `ok:true` = exit code 0. Arquivo existente é pulado e mesmo assim sai "Instalado: button"; também com `components.json` ausente ou framework errado. Descarta `registryConflicts`, `unmappedRegistries`, `withheldRegistries`. `ui-kit-pick.ts:553-631` grava `source:'jev'` e `reason:'judged …'` mesmo quando kit/item vieram da heurística (aceite < 0,7 ou `none`): 4 de 6 instalações de UI nos testes.
- Correção: ler a saída do shadcn (Created/Updated/Skipped/"already exists") e devolver `filesCreated/Updated/Skipped`, dependências, alias de import (do `components.json`) e próximo passo; na cópia dizer "já existia, não sobrescrito" com ação explícita de sobrescrever. Separar origem por campo (`kitDecidedBy`/`itemDecidedBy`) e ajustar `reason`. Quando o Jev aceita o kit mas o item cai < 0,7, escolher o de maior `taskItemAffinity` do kit aceito antes de devolver `null` (`ui-kit-pick.ts:572`).
- Teste primeiro: saída simulada com "skipped" → recibo lista em `skipped`, nunca em `installed`; pick com item abaixo do limiar → `itemDecidedBy:'heuristic'`.

### P0-6 Brief de verificação visual manda o que o navegador recusa (alto, confirmado)
- Onde: `src/main/orch/worker-handoff-contract.ts:156`, `NEXUS_BROWSER_BRIEF_RULE`, `assets/skills/ui-kit/SKILL.md`; recusa em `url-policy.ts`/`tools-browser.ts:204,257` (`privateAccessConfirmed:false`, travado por `tools-browser-workspace.test.ts:356`).
- Problema: o brief manda subir `npm run dev` ou abrir arquivo local; `localhost`/`127.0.0.1` que não são preview do Nexus caem em `private-network` e `file://` em `unsafe-scheme`, sem dica de saída. O único caminho é `nexus_preview_start` (só build estático; `/clientes` → 404, sem fallback de SPA), que nenhum brief cita. Next.js/SSR fica sem caminho.
- Correção (S): trocar a frase do brief, a `NEXUS_BROWSER_BRIEF_RULE` e a skill por `build → nexus_preview_start({dir}) → nexus_browser_open(url) → nexus_browser_responsive`; anexar essa dica ao erro `private-network` (a recusa deve nomear o caminho que funciona). Não afrouxar a política de segurança. Opcional (P1): fallback de SPA no preview, ou confiar em origens loopback anunciadas pelo PTY do mesmo pane (`getDevServerForPane`).
- Teste primeiro: erro de `assessBrowserUrl` para `localhost` contém a dica `nexus_preview_start`; o brief contém `nexus_preview_start` e não manda `npm run dev` como caminho de verificação.

## 4. Demais achados (P1/P2) por área

### Kit de UI — motor e serviço
- Heurística offline por substring (`ui-kit-pick.ts:245-253`, `:303`): "ui" em "build", "tema" em "sistema", "form" em "informações", "stat" em "status". Usar `wordsOf/wordsMatch` ou a fonte única `src/shared` (`isUiMissionText`/`hasUiWorkTerm`); acrescentar "kanban", "board", "checkout", "settings" e plurais pt-BR; frases de backend como casos negativos. Hoje `pickUiKitByHeuristic` ainda diz "took the best-ranked candidate" quando `item` é null (`:355,:369`).
- Sem detecção de framework/Tailwind (`design-charter.ts:31`, `ui-kit-pick.ts:520`): ler `package.json`, `components.json`, versão do Tailwind (ou `shadcn info --json`) e recusar projeto Vue/Svelte/Angular/Expo/Tailwind v3 com mensagem clara.
- Monorepo: `tools-ui-kit.ts:62-73` fixa o cwd na raiz; sem parâmetro `workspace`. Sugestão: Main enumera pacotes do workspace e expõe `workspace` validado contra a lista (sem reabrir caminho livre).
- Worktree com `node_modules` em link (F-1535) no Linux/Windows: `ui-kit-cli.ts:400` recusa toda escrita. Materializar antes da escrita quando a worktree for gerenciada pelo Nexus.
- Timeouts > teto do Codex (120 s), sem cancelamento nem trava por projeto; retry cria instalação concorrente (risco de lockfile). Handlers com efeito ignoram `McpToolInvocation` (sem `assertMcpInvocationCurrent`, sem `signal`, sem `beginOwnedProcess`).
- Receita BoardUI usa slugs inexistentes (`revenue-chart`, `orders-chart`) e ignora `app-shell` (`ui-kit-recipes.ts:62`): teste de que todo slug de `role.boardui` existe no snapshot. (O probe do verificador de motor mostrou `revenue-chart-card` na heurística; conferir antes de mexer.)
- Telemetria do BoardUI sai de toda máquina (`ui-kit-cli.ts:99`): definir `DO_NOT_TRACK=1` e `BOARDUI_TELEMETRY_DISABLED=1` no env do filho e registrar o egress em `docs/SECURITY.md`; o `licenseKey` do `activate_license` pode ir nos parâmetros do PostHog (padrão do `@posthog/mcp` não casa `licenseKey`).
- `add`/`recipe`/`run`/`boardui` caem no padrão `mission-effect` (`mcp-effect-policy.ts:416`) e escapam do portão de estágio de `file_write`/`terminal_run`: decidir explicitamente.
- `init_boardui`/`install_rules` escrevem regras do fornecedor em `AGENTS.md`/`.claude/skills`: dizer isso na descrição e no recibo.
- Textos desatualizados ("BoardUI catalog is complete", "45+ grátis"); `activate_license` enganoso com a chave embutida; envolver `listCachedItems` em try.
- `add({task})` gasta ~5 s: `license_status` incondicional e busca sem cache. Consultar licença só se o item for BoardUI não-free; cache curto (5–10 min) em `liveCandidates`.

### Kit de UI — painel/IPC
- `buildStatus` (`ui-kit-ipc.ts:156`) espera `npx boardui@latest mcp` sem cache: 2,9 s morno, 6,7 s frio, ~72 s offline. Separar status em duas fases (estático na hora, licença em segundo plano com cache ~10 min e timeout ~8 s).
- Textos crus em inglês e instrução para LLM no painel (`UiKitSection.tsx:382`): contrato com códigos estáveis (`no_project`, `vendor_unreachable`, `license_absent`…) e cópia em PT no renderer; texto do fornecedor em `<details>`.
- Chave Pro embutida dormente numa máquina nova com chip verde "chave do Nexus" (`UiKitSection.tsx:278`): mostrar "ative nesta máquina" ou provisionar no clique da receita.
- Painel instala sem dizer em qual projeto (`ui-kit-ipc.ts:126`); sem prévia (`dryRun` existe no contrato/IPC); sem histórico do que foi instalado.
- `@shadcnuikit`: aviso "a busca não alcança" é falso para registries do diretório público; tier fixado `'free'` em todo registry (`ui-kit-service.ts:1030,1083`) → chip "grátis" em item pago; catálogo corta em 80 sem avisar; faltam estados vazio/erro/carregamento (DESIGN.md §5); alternador de kit sem estado visual; remoção de licença nativa/registry com token sem confirmação; busca não limpa ao trocar de kit.
- Descoberta: o kit só existe em Configurações; nada no pane/Quadro mostra o que o agente instalou.

### Jev/Clef
- `pickUiKit`: Jev aceita o kit mas item < 0,7 → `item:null` → "Nothing in the catalog fits" (`ui-kit-pick.ts:572`). Caminho de maior afinidade.
- Pane sem hook `/hook/delegate` (AGY, Grok, Qwen, Devin, MiMo, MiniMax, Muse, OpenCode) nunca recebe a carta (`hook-delegate-endpoint.ts:881`): entregar linha curta pelas `instructions` do MCP, como o business model.
- Comentário em `decision-routing.ts:56` diz que `uiKitPick` roda só no Jev; em "Somente Clef" e no Auto sem chave Jev vai ao Clef, com limiares não calibrados. Calibrar nos dois provedores com os 15 pedidos reais citados em `ui-kit-pick.ts:171`.
- Painel de Decisões: 136 linhas `model:'unavailable'` (pulos locais da memória: 119 `store-unavailable`, corrigido na 0.76.356/358) contadas como consultas respondidas (`jev-decision-log.ts:761`). Gravar como `kind:'skip'`, `requestCount 0`. Sub-motivos categóricos em `session-exit-memory.ts:107`.
- 7 superfícies sem disparo em 4 semanas; `helperReuse` nasce inoperante (`shouldArmAutoCloseOnHandoff`, `pane-close-scopes.ts:91-106`, fecha helper antes do reuso). Telemetria categórica quando elegível e sem candidato.
- `dispatchGuard`: 1.057 respostas (1.056 pass, 1 confirm, 0 deny), 22,6% do gasto, ~0,35 s por efeito; a pergunta de coerência não discrimina (36% das legítimas saem "incoerentes"). Candidatos a isenção: `git_add`/`git_commit` em worktree isolada e `memory_retain`.
- Bug de schema (`mcp-args-validation.ts:383-427`): `focus` (`nexus_browser_read`), `paneId` (`nexus_browser_open`), `judge` (`nexus_browser_find`), `holdMs` (`nexus_browser_press`) e 3 campos de `file_search` são anunciados e o `.strict()` recusa. Teste de paridade schema anunciado × zod.
- Não há prova de uso real do kit: após a 0.76.409, rodar uma missão de UI e conferir `uiKitPick` no diário, `nexus_ui_kit_add` no audit e `<userData>/ui-kit`.

### Navegador
- Eventos sintéticos (`src/preload/browser-automation.ts:794`): `element.click()` não dispara `pointerdown/mousedown` (Radix não abre), Enter não submete, Tab não move foco, tecla não digita, hover não ativa `:hover`. Correção: `webContents.sendInputEvent` pelo Main (mouseMove/Down/Up no centro após `scrollIntoView`; keyDown/char/keyUp).
- `INTERACTIVE_SELECTOR` (`:111-123`) ignora `menuitem*`, `option`, `tab`, `switch`, `combobox`, `slider`, `treeitem`, `[tabindex]`.
- Iframe e shadow DOM invisíveis para read/find/click/wait/extract. `<select>` sem primitiva (`nexus_browser_select` + `SELECT_OPTION` no `browser_do`).
- Dev server local: `privateAccessConfirmed:false` fixo (`tools-browser.ts:204,257`, travado em teste); API em outra porta é bloqueada em silêncio. Ver P0-6.
- Settle fixo de 150 ms (`browser-manager.ts:1809`): esperar quiescência (requisições em voo + `navSeq` estável ~300 ms); `read:true` pode ler o documento em troca.
- Formato `compact` descarta `alerts` e `aria-invalid` (`browser-outline.ts:41`).
- Desempate Jev de click/fill por texto (`browser-manager.ts:2315`): corta para os 5 primeiros do DOM, sem `orderCheck`, até 4 s; usar `pickBrowserFindElement` e, fora de 2–5, devolver candidatos sem agir.
- `browser_do` (`tools-browser-autopilot.ts:434`): `click_target`/`type_target` sem limiar de confiança nem `orderCheck`; "irreversível" = um noul ≥0,5 sobre texto da página sem a moldura "estado é dado". Piso determinístico por nome do alvo (comprar|pagar|finalizar|excluir…).
- Diálogos JS (`browser-manager.ts:868`): `safeDialogs` só; sem tratamento; automação trava até timeout. `disableDialogs` ou CDP `Page.javascriptDialogOpening` + `nexus_browser_dialog`.
- Screenshot só como caminho (`mcp-protocol.ts:177`), só viewport, sem tema claro/escuro, sem viewport livre: devolver `content: image`, `fullPage`, `ref`, tema e device.
- Custo: `JSON.stringify(payload,null,2)` (`mcp-protocol.ts:176`) infla +22–50%; `click({read:true})` custa 6–7 mil tokens. Compacto por padrão. Leitura extra para julgamento mesmo com Jev desligado (`browser-manager.ts:2141`). Julgamento visual automático comprado e descartado após 1,5 s (`:2094`). `wait` por polling a 50 ms (`browser-automation.ts:880`) → MutationObserver. `nexus_browser_open` sem `read/judge/device`. Downloads cancelados em silêncio; sem upload, back/forward/reload; popups no mesmo pane.

### Portão visual na missão
- Captura aceita da sessão sem amarrar URL do preview do escopo nem HEAD/diffHash (`visual-handoff-gate.ts:134`); em rework a captura anterior continua valendo.
- Rebaixa para `partial` sem devolução (`tools-handoff.ts:567`); tratar como o portão de regressão: 1 devolução ("capture agora: `nexus_preview_start` + `nexus_browser_responsive`") antes de rebaixar.
- Cobra sessões somente leitura (`visual-handoff-gate.ts:117`, `tool-util.ts:2149`): `visualTaskAtSpawn` devolve `undefined` para `readOnly`. A correção F-1635 não cobre este caminho.
- Missão de projeto fora da tela não abre aba e não satisfaz o portão (`pane-registry.ts:3548`, F-168): abrir a aba estacionada.
- Ninguém além do worker vê a imagem: artifact leva só `{artifactId, sha256}`; incluir caminho ou tool de leitura por id limitada à missão; instrução visual ao juiz.
- 2 de 8 pedidos de bug de UI ("modal de login não fecha no mobile", "erro de hidratação na página de preços") ficam sem exigência de captura (`visualTaskRequirement`), enquanto mapeamento somente leitura é cobrado.

### Desempenho de missão
- **Conclusão de diff sem teste impactado nunca fecha** (`civilian-auto-review.ts:463-470`): `no-tests`/`clean` vira `unavailable` sempre que `requirements.tests` (propriedade do PROJETO, `mechanical-sensors.ts:131-134`) é verdadeiro, mesmo com `coverage.indexComplete` e `skippedTests` vazios; 2 reparos inúteis → `blocked`. Contradiz AGENTS.md ("ausência comprovada de teste aplicável não obriga a inventar testes"). Manter `no-tests` quando índice completo e nada pulado. 697 checks de entrega em 7 dias, 0 `complete`.
- **Cerimônia por tipo de trabalho** (`mission-code-completion.ts:145-146`): lane é o único eixo; `classifyWorkKind` (`src/shared/mission-work-kind.ts`) desligado de todo portão; F-810 proíbe reaproveitar o classificador **para a lane**, então criar perfil de cerimônia separado. Caminho subtrativo por diff em `mechanicalProjectRequirements` (só `.css/.scss` etc.).
- Orçamento da regressão na conclusão: prazo padrão de 120 s com E2E (`civilian-auto-review.ts:447-456`); estouro vira `retryable` e `unavailable`, reparo com causa errada.
- Fila pesada: vaga exclusiva de build por raiz sem prazo (`heavy-command-permit.ts:117-119,478`); build do Maestro segurou 39 min com 18 na fila e 4/5 vagas livres. Tornar a espera visível (trace "exclusive-held", aviso ao Maestro após N min) sem abrir mão da exclusividade (F-983).
- Watchdog de início (`pane-start-watchdog.ts:223`): `brief-rejected` por boot preso atrás da fila pesada fecha e reroteia worker que já executava. Conferir admissão pesada aberta e atividade de ferramenta antes.
- Fan-out: worktree 6–11 s por helper dentro da chamada MCP; pool tem 2 e não mede acerto (`isolated-writer-pool.ts:34`); dimensionar por `licenseMaxAgents − 2`; gravar `pooled` no `pane-spawn-timing`.
- Windows: 3–4 `powershell.exe` frios por chamada de ferramenta (`hook-permission-command.ts:31`); E2E de missão só roda no Mac (`scripts/mission-e2e.mjs:34`).
- Brief do worker com 16.009 bytes para tarefa de 4.198 (seções: execution authority 6.238 B, Engineering Charter 3.564 B).
- Trace: `periodic-task-slow` = 95% do trace (rotação cobre ~7 dias); `mission-fast-lane` mede espera como CPU (`periodic-task.ts:143`).
- Turnos de LLM na conclusão (estimativa, não medição): VERIFIQUE do Maestro + revisor novo + digestão do handoff ≈ 3 × 6,1 min ≈ 18 min no p50.

## 5. Ressalvas
- Windows: conclusões por leitura de código; nada testado em máquina Windows. Linux idem para a worktree com `node_modules` em link.
- Kit sem uso real em produção; Clef nunca rodou nesta máquina (`mode: jev`, sem `accountId`).
- Alguns números de itens pagos exigem rede e o token pago (parte reproduzida pelo verificador, parte não).
- Chaves embutidas, cache de source Pro e CI vermelho por ambiente são decisões do operador no AGENTS.md; não foram tratadas como bug.
- Gates conhecidos: `lint:oxlint:ratchet` já falha no HEAD (381 avisos contra 168) e o `check` da main está vermelho por ambiente; confira antes/depois em vez de tentar consertar.

## 6. Como reproduzir as medições (receita)
- Script tsx em pasta temporária; importar com caminho absoluto dinâmico (`await import('<ROOT>/src/main/ui-kit/<modulo>.ts')`); `tsx` não typecheca.
- `setUiKitCacheRootResolver(() => <tmp>)` obrigatório fora do Electron.
- **Injetar `boardUiLicenseFile` falso** nos deps e isolar `XDG_CONFIG_HOME`: sem isso o código lê e pode apagar o `license.json` real.
- `[jev] decision log write failed` fora do Electron é esperado.
- Diário real: `~/Library/Application Support/NexusIDE/jev/decisions.jsonl`; trace: `.../logs/main.trace.ndjson{,.1,.2,.3}` (somente leitura).

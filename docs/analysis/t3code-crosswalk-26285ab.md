# Cruzamento T3 Code → Nexus (pin 26285ab)

Fonte: pingdotgg/t3code @ `26285ab80513260d1ff29d2c3fbe18f21990cb62` (MIT, © 2026 T3 Tools Inc.). Proveniência do que entrou: `third_party/provenance/t3code-26285ab.json` e `THIRD_PARTY_NOTICES.md`.

Os 64 candidatos vêm de cinco estudos somente leitura da missão `mission-23eee6e5`: WEB18 (UI/web), MOB14 (mobile), ORC10 (orquestração), DSK11 (desktop/remoto/terminal) e QLT11 (runtime/perf/qualidade). A auditoria foi feita na branch `harvest/t3-integration` em `b96b3c805` (0.76.211 + F-1015) e conferida pelo Maestro depois de F-1014 (`1295a737c`).

Critério: **integrado e acessível** exige código presente E ponto de uso que o usuário alcança no Nexus. Código só no caminho Orca do app móvel não conta: o host Nexus do celular é `mobile/src/nexus-host/NexusHostScreen.tsx` + `mobile/src/transport/nexus-bridge-rpc-adapter.ts`. "Integrado" aqui prova existência e ponto de uso por leitura de código, não comportamento em aparelho.

## Contagem da auditoria histórica (0.76.211)

| Classificação | Nº | IDs |
|---|---|---|
| Integrado e acessível | 39 | WEB-01..12, WEB-13 (parcial), WEB-17; MOB-01, MOB-02, MOB-03, MOB-05, MOB-07, MOB-09, MOB-11, MOB-12, MOB-13; ORC-03, ORC-05, ORC-10; DSK-01..06; QLT-01..03, QLT-05..07, QLT-11 |
| Equivalente existente | 4 | MOB-06; ORC-07, ORC-08, QLT-08 |
| Pendente | 20 | WEB-14..16, WEB-18; MOB-04, MOB-08, MOB-10, MOB-14; ORC-01, ORC-02, ORC-04, ORC-06; DSK-07..11; QLT-04, QLT-09, QLT-10 |
| Incompatível | 1 | ORC-09 |

## Tabela da auditoria histórica

| ID | Candidato | Classificação | Evidência | Próximo passo |
|---|---|---|---|---|
| WEB-01 | Presença de painel por escopo | integrado | `src/renderer/lib/panel-presence.tsx`; `ContextualPanel.tsx:24`, `product/AppShell.tsx:15` | — |
| WEB-02 | Foco modal e Enter durante IME | integrado | `components/CommandPalette.tsx`, `CommandPaletteContent.tsx`, `DirectionComposer` | — |
| WEB-03 | Imagens HEIC/HEIF e compressão | integrado | `lib/image-compression.ts`; `mission/MissionAttachmentPicker.tsx:22` | — |
| WEB-04 | Diff Pierre com realce e intervalos | integrado | `lib/diff-rendering.ts`; `GitPanelBody.tsx:30`, `diffs/AnnotatableCodeView.tsx:21` | — |
| WEB-05 | Motion de listas com orçamento | integrado | `lib/rail-list-motion.ts`; `product/WorkspaceRail.tsx:43` | — |
| WEB-06 | Timeline virtualizada | integrado | `lib/activity-timeline-scroll.ts`; `mission/AgentActivityTimeline.tsx:22` | — |
| WEB-07 | Quota conjunta por conta | integrado | `lib/quota-pool.ts`; `settings/QuotaPool.tsx:21` | — |
| WEB-08 | Árvore dos arquivos alterados | integrado | `diffs/DiffFileTree.tsx`; `GitPanelBody.tsx:41,153` | — |
| WEB-09 | Paleta de comandos/arquivos/conteúdo | integrado | `lib/command-palette-logic.ts`; `App.tsx:51` | — |
| WEB-10 | Importar tema do VS Code | integrado | `styles/vscode-theme-import.ts`; `settings/AppearanceSection.tsx:12` | — |
| WEB-11 | Atalhos configuráveis | integrado | `lib/keybindings.ts`; `settings/CatalogSectionsOps.tsx:35` | — |
| WEB-12 | Uso histórico em SVG | integrado (F-1030) | rollup diário de 90 dias em `main/pet/pet-stats.ts` → `usage:history`; `settings/UsageHistoryChart.tsx` em `UsageQuotaSection.tsx` (código do Nexus, sem cópia do upstream) | — |
| WEB-13 | Rearranjo de abas/grupos | integrado (F-1032, parcial) | `lib/tab-drag.ts` + `state/tab-order-store.ts`; arraste, Alt+Shift+←/→ e menu em `product/WorkspaceTabs.tsx`, ordem aplicada em `TerminalWorkspace.tsx` (código do Nexus, sem cópia do upstream) | só dentro da barra única; o Nexus não tem grupos de abas entre os quais mover |
| WEB-14 | Markdown incremental e Mermaid | pendente (M) | markdown básico existe; sem incremental/Mermaid no desktop | renderer de mensagem |
| WEB-15 | Referências inline e @menções | pendente (M) | sem referência inline | `lib/inline-references.ts` + composer |
| WEB-16 | Editor Tiptap | pendente (G) | `tiptap` ausente | decisão de dependência antes |
| WEB-17 | Citar resposta com origem estável | integrado (F-1031) | `lib/quote-reference.ts`; "Citar" em `mission/AgentActivityTimeline.tsx` → `DirectionComposer` da barra do `MissionBoard.tsx` (código do Nexus, sem cópia do upstream) | Lista simples e aba Conversa sem citação |
| WEB-18 | Importação guiada de histórico de CLI | pendente (G) | sem importador | módulo + UI |
| MOB-01 | Virtualização Legend | integrado | `MobileLegendList.tsx` nas listas do caminho Orca e do host Nexus: missões/panes (`NexusHostScreen.tsx`), alterações, pastas, diff e leitura (`NexusPaneWorkspace.tsx`) (F-1021) | — |
| MOB-02 | Diff por chunks com realce | integrado | `source-control/mobile-review-*`; no host Nexus por `NexusPaneWorkspace.tsx` com os dados de `git.diff` da bridge (F-1014) | — |
| MOB-03 | Outbox durável | integrado | `session/mobile-thread-outbox*` + `nexus-host/use-nexus-host-outbox.ts` (F-1015) | — |
| MOB-04 | Atalhos do launcher do SO | pendente (M) | sem quick actions | `mobile/src/platform/quick-actions.ts` |
| MOB-05 | Cartão de atividade do agente | integrado | push `pane.activity` + `pane.activity.list` da bridge a partir do estado do PTY e dos planos de "pede você" (`src/main/remote/remote-pane-activity{,-sources}.ts`, só panes legíveis, agrupado e limitado); cartão e selo em `NexusHostScreen.tsx` / `NexusPaneActivityCard.tsx` (F-1021) | — |
| MOB-06 | Rotas ordenadas + supervisor de retry | equivalente | `transport/mobile-endpoint-supervisor.ts`, `rpc-client-reconnect-schedule.ts` | — |
| MOB-07 | Aprovação estruturada pelo celular | integrado | `shared/approval-decision.ts`; `NexusHostScreen.tsx` + `MobileNativeChatPermission` | — |
| MOB-08 | Ditado no aparelho | pendente (M–G) | `nexus-command-dictation.ts` desligado no host Nexus: o desktop Nexus não tem transcritor local para `speech.dictation.*` | STT local no desktop ou módulo nativo no app (exige aparelho para provar) |
| MOB-09 | Canais Android + política de foreground | integrado | `notifications/agent-notification-channels.ts`; `nexus-host-notifications.ts` (aprovação + "esperando você"/"terminou" de MOB-05, F-1021) | — |
| MOB-10 | Snapshots limitados offline-first | pendente (G) | sem cursor/`hasMore` em `pane.read` | paginação com cursor |
| MOB-11 | Haptics nos gestos | integrado | `platform/gesture-haptics.ts`; `home/MobileHomeScreen.tsx:13` | — |
| MOB-12 | Pareamento com escopos estreitos | integrado | F-1022: `scopes` no grant (`remote-device-token-store.ts`; legado = todos), checagem central `device-scopes.ts` no `handleAuthedMessage` (tipo desconhecido recusado), snapshot/lista filtrados sem `read`; escolha e edição no card *Celular na rede local*; app mapeia `nexus_scope_refused` | — |
| MOB-13 | Gate `mobile:doctor` | integrado | `mobile/scripts/mobile-doctor.mjs` | — |
| MOB-14 | Superfície nativa de diff | pendente (G) | depende de medir MOB-02 | avaliar depois |
| ORC-01 | Outbox transacional + classes replay-safe | pendente (M) | só `handoff-delivery-outbox.ts` | `orch/effect-outbox*` |
| ORC-02 | Turno terminal ≠ efeito assentado | pendente (M) | sem supervisor de assentamento | depende de ORC-01 |
| ORC-03 | Checkpoint em ref oculta | integrado | `git/hidden-checkpoint.ts`; `orch/tools-checkpoint.ts:41` | — |
| ORC-04 | Recibo de comando com `resultSequence` | pendente (M) | sem `command_receipts` | com ORC-01 |
| ORC-05 | Handoff de contexto orçado | integrado | `orch/context-handoff-budget.ts`; `failover-mission-respawn.ts:30` | — |
| ORC-06 | Reconcile de boot do provider | pendente (M) | só `pane-start-watchdog.ts` | depende de ORC-01 |
| ORC-07 | Política steer/fork por capacidade | equivalente | não há ponto de decisão steer × interromper: a política é uma só para toda CLI — nada é digitado no meio de uma resposta; entrega e pipe esperam o pane ocioso (`orch/idle-delivery.ts` cabeçalho, `orch/pane-pipe.ts:274,357` via `isSessionInjectableIdle`). Nenhum manifesto em `src/adapters/builtin/*.json` declara steer/interrupção; uma tabela sem chamador seria abstração sem consumidor | só se o Nexus passar a injetar com o pane ocupado (exige provar cada CLI ao vivo) |
| ORC-08 | Drenar worker em teste | equivalente | a drenagem vive nas primitivas com consumidor: `KeyedLock.idle()` (F-1025) e `KeyedCoalescingWorker.drain()` (F-1026), atrás de `hiddenCheckpointIdle`, `worktreeSalvageIdle` e `operatorHandGcIdle`, que os testes de checkpoint, salvaguarda e writer isolado já aguardam | — |
| ORC-09 | Arquivar por PR mergeado/inatividade | incompatível | missão Nexus não arquiva sozinha; conflita com `integration-review-gate.ts` e o ciclo done/failed/blocked | não portar |
| ORC-10 | Teto de replay do stream | integrado | `orch/mission-event-replay-budget.ts`; `mission-event-journal.ts:28` | — |
| DSK-01 | Sanitizar replay do scrollback | integrado | `shared/terminal-replay-sanitizer.ts`; `renderer/terminal/terminal-host.ts:127` | — |
| DSK-02 | Tailscale Serve na bridge | integrado | `remote/tailscale.ts`, `remote-bridge-tailscale.ts` | — |
| DSK-03 | Grade libghostty-vt | integrado | `detect/ghostty-runtime.ts`, `ghostty-screen.ts`; `screen-buffer.ts` | — |
| DSK-04 | Importação de 9 navegadores | integrado | `browser/browser-import/*`; `browser-manager.ts:12` | — |
| DSK-05 | Snapshot SQLite antes de migrar | integrado | `persistence/db-migration-snapshot.ts`; `db.ts:203,290` | — |
| DSK-06 | `--password-store` no Linux | integrado | `main/linux-secret-store.ts` | — |
| DSK-07 | Histórico limitado do daemon PTY | pendente (P–M) | bloqueado pela fase 2 do ptyd | `pty-daemon/*` |
| DSK-08 | Monitor de recursos nativo | pendente (M–G) | só RSS em `pane-footprint.ts` | binário + cliente |
| DSK-09 | Serviço launchd/systemd | pendente (M) | sem `boot-service.ts` | fase 2 do ptyd |
| DSK-10 | CdpRelay | pendente (M, risco alto) | CDP só em dev | relay loopback com token |
| DSK-11 | Backend WSL | pendente (G) | `remote/wsl-detect.ts` é stub | porte |
| QLT-01 | Gate de orçamento de perf no CI | integrado | `package.json` `test:perf`; `ci.yml` | — |
| QLT-02 | `KeyedLock` | integrado | `src/main/util/keyed-lock.ts`; 5 consumidores que tinham a fila copiada à mão: `git/hidden-checkpoint.ts`, `orch/isolated-writer-salvage.ts`, `design/design-instrument-ledger.ts`, `design/design-writeback-service.ts` (a cópia não soltava a chave), `context/orientation/orientation-service.ts` (F-1025) | — |
| QLT-03 | `KeyedCoalescingWorker` | integrado | `src/main/util/keyed-coalescing-worker.ts`; consumidores: badges do modo design (`browser/browser-manager.ts`, antes um round-trip por mutação) e GC de worktrees integradas (`orch/isolated-writer-worktree.ts`, antes o mesmo padrão à mão) (F-1026) | — |
| QLT-04 | knip | pendente (M) | sem config | dep + CI |
| QLT-05 | `require-suppression-reason` | integrado | `oxlint-plugin-nexus/rules/require-suppression-reason.mjs` | — |
| QLT-06 | `no-test-in-loop` | integrado | `oxlint-plugin-nexus/rules/no-test-in-loop.mjs` (erro no `.oxlintrc.json`, CI `lint:oxlint --quiet`); 17 laços convertidos em `it.each`/`it.for` (F-1023) | — |
| QLT-07 | `no-raw-ipc` | integrado | `oxlint-plugin-nexus/rules/no-raw-ipc.mjs` (erro no CI): IPC cru só nos wrappers, nas pontes do preload e em 48 arquivos com teto exato e motivo (`RAW_IPC_ALLOWLIST`); `perf:snapshot` e `model:richMetadata` migrados para `handleTrusted` (F-1024) | baixar os tetos do legado canal a canal |
| QLT-08 | `DrainableWorker` | equivalente | ver ORC-08: `drain()`/`idle()` das primitivas de QLT-02/03; uma classe `DrainableWorker` à parte não teria consumidor | — |
| QLT-09 | Paginação por cursor | pendente (G) | só gap buffer de terminal | histórico de missão |
| QLT-10 | Nome de ação = nome acessível | pendente (M) | não é barato hoje: sem infra de a11y (sem axe nem testing-library; os testes de renderer leem `aria-label` à mão). Uma regra estática acharia só 2 pares `aria-label` + texto fixo no renderer, ambos glifos (`✕` em `UpdateModal.tsx:517`, `≡` em `BrowserDesignBar.tsx:424`), em que o rótulo substitui o símbolo com razão; o resto dos rótulos é dinâmico | calcular o nome acessível no DOM renderizado (jsdom + axe ou equivalente) |
| QLT-11 | Telemetria só com assinante | integrado | `perf/pane-footprint-broadcast.ts` (coleta só com assinante, geração por religada, sequência por geração); `pty/pane-footprint.ts` (PID + início; já em `122cf2ec8`, a auditoria errou ao dar como ausente); store do renderer descarta geração anterior (F-1027) | — |

## Limites desta auditoria

- Os estudos foram lidos do banco do projeto, porque a tool não lê handoffs de outra missão. As linhas do T3 citadas vêm dos estudos, não de releitura do upstream.
- Nada foi exercitado em aparelho, simulador ou navegador nesta auditoria.
- Licenças de `@pierre/diffs`, `@legendapp/list`, `nitro-markdown`, `@react-native-ai/apple`, `@napi-rs/keyring` e `@crowecawcaw/xa11y` vêm dos estudos e não foram reverificadas sem rede.

## Atualização de escopo para 0.76.218 (09/10)

A contagem 39/4/20/1 acima pertence ao snapshot descrito no início; não é uma
contagem refeita de recursos da 0.76.218. A PR126 até a fronteira `ad517bfb`
foi integrada por ancestralidade; commits posteriores ficam no próximo lote
monitorado. A revisão e as correções preservam a diferença entre código
presente, consumidor de produção e prova operacional. Os pontos abaixo
atualizam as descrições antigas sem anunciar paridade de todos os 64 itens.

| Item | Estado observado no lote 214 | Limite/ponto restante |
|---|---|---|
| WEB-14 | Mermaid, configuração protegida, fila serial e DOMPurify estão instalados; `MarkdownWithMermaid` monta SVG saneado em ShadowRoot, exercitado com o motor real em Chromium. | Componente ainda sem consumidor de mensagem no produto; markdown incremental não foi entregue por esta PR. |
| WEB-16 | Dependências Tiptap presentes; `ComposerTiptapEditor` usa o SDK real, com testes de linhas, ciclo controlado, seleção, readonly e persistência de marcas/texto. | O composer de produto não foi substituído; a existência do componente não prova integração da superfície. |
| WEB-18 | `cli-history-import` e `cli-history-sweep` existem como helpers de JSONL. | Falta o comando/serviço/UI que importa e grava no store; não equivalem ao worker SDK do T3. |
| ORC-01/04 | Admissão Main grava observação lógica e sequência saneadas, com identidade imutável; no PTY, sessão/canal privado vêm do Main e seu encerramento cancela chamadas ainda aguardando despacho. `terminal_run`/`bg_run` registram obrigação antes da preparação e assentam prova real de saída/recibo/outbox na mesma conexão e escopo. | ACK lógico não prova efeito físico. Não há cache de stdout/segredos, replay automático de mutações incertas ou checkpoint genérico; retry sem resultado informa indisponibilidade. |
| ORC-02 | Consumidor civil consulta bloqueadores duráveis e entregas ainda na fila; só exclui o Maestro antes do limiteSQL. Comandos instrumentados mantêm obrigação física durante timeout, ACK de background e saída dos descendentes. Primeira onda exige setup/kickoff confirmados; direções durante bootstrap ficam na fila da tentativa possuída e só a prova atual libera entrega correlacionada. Falha só terminaliza a tentativa ainda possuída. | Fatos de saída sem prova após perda do processo ficam unknown e bloqueiam conclusão. Provas nativas focadas não substituem os gates completos de missão e do pacote. |
| ORC-06 | Boot/registro reconciliam o outbox antes de efeitos; obrigações sem prova ficam unknown, inclusive após poda legada. Manutenção por escopo remove até 500 efeitos assentados e 100 recibos gerados elegíveis por passagem; falha local preserva o escopo e não trava os saudáveis. | Cancelamento/perda do registry interrompem a passagem. Vínculos explícitos/unknown ficam preservados; não reconstruir sessões nem anunciar reconciliação de todas as CLIs. |
| DSK-08 | Amostrador TS `resource-monitor` existe. | Sem binário nativo/consumidor produtivo; não equivale ao monitor Rust do T3. |
| DSK-10 | Relay puro e adapter Electron de escopo/ciclo de vida revisados. Exposição HTTP/WebSocket experimental fechada por violar proteção de dados e visão. | Endpoint rawCDP/Playwright precisa de contrato de confiança próprio. Preview estático e ferramentas tipadas do Nexus são as operações suportadas. |
| DSK-11 | `wsl-runtime` planeja argv/ambiente/slots por distro, com referência atribuída. | Sem executor PTY/credenciais/validação Windows real. |
| QLT-04 | `knip.jsonc` e scripts `knip`, `knip:check`, `knip:production` presentes e acessíveis. | Achados de uso/dependências são relatório de qualidade; não afirmar gateCI verde por existir configuração. |
| QLT-09 | `nexus_handoff_list` tem cursor keysetSQL; só os ids devolvidos são marcados vistos, com validação/dedupe/lotes. | Não substitui todo histórico de missão, stream do terminal ou snapshots offline do celular. |
| QLT-10 | Registry de nomes acessíveis e tela de início (MissionSetup; o Launcher órfão saiu no F-1174) conectada, com atalhos1–6 e bloqueio de repeat/editáveis testados. | Não equivale a uma regra global que computa nomes acessíveis em todas as superfícies. |

Proveniência: `third_party/provenance/t3code-26285ab.json` e
`THIRD_PARTY_NOTICES.md`; revisão por achado em `docs/qa/items/F-1049.md`,
F-1062–1069, F-1071–1094. Evidências de componente/fundação não substituem o
full regression, Main/PTY/missão, pacote assinado, runtime/soak e publicação
verificada. WSL/aparelho/provedor pago mantêm seus limites de prova.

A verificação privada de runtime usa `coordinationScope ?? scope` para os
agentes que executam em worktrees, preservando a identidade do checkout e
as guardas de colisão. Credenciais de API/transporte não são evidência de
assinatura nativa do Claude. Isso não amplia a superfície de ferramentas,
as permissões nem os limites de prova publicados acima.

Orientações enfileiradas ainda sem prova de aceitação são representadas como
não comprovadas, com erro explícito e sem promover a fila a execução. Um
resultado ambíguo não autoriza repetir o mesmo pedido. As guardas de escopo,
identidade, permissões e prova física permanecem as mesmas.

# Cruzamento T3 Code → Nexus (pin 26285ab)

Fonte: pingdotgg/t3code @ `26285ab80513260d1ff29d2c3fbe18f21990cb62` (MIT, © 2026 T3 Tools Inc.). Proveniência do que entrou: `third_party/provenance/t3code-26285ab.json` e `THIRD_PARTY_NOTICES.md`.

Os 64 candidatos vêm de cinco estudos somente leitura da missão `mission-23eee6e5`: WEB18 (UI/web), MOB14 (mobile), ORC10 (orquestração), DSK11 (desktop/remoto/terminal) e QLT11 (runtime/perf/qualidade). A auditoria foi feita na branch `harvest/t3-integration` em `b96b3c805` (0.76.211 + F-1015) e conferida pelo Maestro depois de F-1014 (`1295a737c`).

Critério: **integrado e acessível** exige código presente E ponto de uso que o usuário alcança no Nexus. Código só no caminho Orca do app móvel não conta: o host Nexus do celular é `mobile/src/nexus-host/NexusHostScreen.tsx` + `mobile/src/transport/nexus-bridge-rpc-adapter.ts`. "Integrado" aqui prova existência e ponto de uso por leitura de código, não comportamento em aparelho.

## Contagem

| Classificação | Nº | IDs |
|---|---|---|
| Integrado e acessível | 32 | WEB-01..12, WEB-17; MOB-01 (parcial), MOB-02, MOB-03, MOB-07, MOB-09, MOB-11, MOB-13; ORC-03, ORC-05, ORC-10; DSK-01..06; QLT-01, QLT-05, QLT-11 (parcial) |
| Equivalente existente | 1 | MOB-06 |
| Pendente | 30 | WEB-13..16, WEB-18; MOB-04, MOB-05, MOB-08, MOB-10, MOB-12, MOB-14; ORC-01, ORC-02, ORC-04, ORC-06, ORC-07, ORC-08; DSK-07..11; QLT-02, QLT-03, QLT-04, QLT-06..10 |
| Incompatível | 1 | ORC-09 |

## Tabela

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
| WEB-13 | Rearranjo de abas/grupos | pendente (M) | sem drag de abas | `lib/tab-drag.ts` + hosts de aba |
| WEB-14 | Markdown incremental e Mermaid | pendente (M) | markdown básico existe; sem incremental/Mermaid no desktop | renderer de mensagem |
| WEB-15 | Referências inline e @menções | pendente (M) | sem referência inline | `lib/inline-references.ts` + composer |
| WEB-16 | Editor Tiptap | pendente (G) | `tiptap` ausente | decisão de dependência antes |
| WEB-17 | Citar resposta com origem estável | integrado (F-1031) | `lib/quote-reference.ts`; "Citar" em `mission/AgentActivityTimeline.tsx` → `DirectionComposer` da barra do `MissionBoard.tsx` (código do Nexus, sem cópia do upstream) | Lista simples e aba Conversa sem citação |
| WEB-18 | Importação guiada de histórico de CLI | pendente (G) | sem importador | módulo + UI |
| MOB-01 | Virtualização Legend | integrado (parcial) | `MobileLegendList.tsx` nas listas do caminho Orca; o host Nexus ainda usa `FlatList` (`NexusPaneWorkspace.tsx`) | LegendList nas listas do host Nexus |
| MOB-02 | Diff por chunks com realce | integrado | `source-control/mobile-review-*`; no host Nexus por `NexusPaneWorkspace.tsx` com os dados de `git.diff` da bridge (F-1014) | — |
| MOB-03 | Outbox durável | integrado | `session/mobile-thread-outbox*` + `nexus-host/use-nexus-host-outbox.ts` (F-1015) | — |
| MOB-04 | Atalhos do launcher do SO | pendente (M) | sem quick actions | `mobile/src/platform/quick-actions.ts` |
| MOB-05 | Cartão de atividade do agente | pendente (M) | a bridge só empurra `approvals.changed` | push de transição de pane + card |
| MOB-06 | Rotas ordenadas + supervisor de retry | equivalente | `transport/mobile-endpoint-supervisor.ts`, `rpc-client-reconnect-schedule.ts` | — |
| MOB-07 | Aprovação estruturada pelo celular | integrado | `shared/approval-decision.ts`; `NexusHostScreen.tsx` + `MobileNativeChatPermission` | — |
| MOB-08 | Ditado no aparelho | pendente (M–G) | `nexus-command-dictation.ts` desligado no host Nexus: o desktop Nexus não tem transcritor local para `speech.dictation.*` | STT local no desktop ou módulo nativo no app (exige aparelho para provar) |
| MOB-09 | Canais Android + política de foreground | integrado | `notifications/agent-notification-channels.ts`; `nexus-host-notifications.ts` (só aprovação) | ampliar com MOB-05 |
| MOB-10 | Snapshots limitados offline-first | pendente (G) | sem cursor/`hasMore` em `pane.read` | paginação com cursor |
| MOB-11 | Haptics nos gestos | integrado | `platform/gesture-haptics.ts`; `home/MobileHomeScreen.tsx:13` | — |
| MOB-12 | Pareamento com escopos estreitos | pendente (M) | `src/main/remote/device-pairing.ts` sem `scopes[]` | escopos no grant + filtro de snapshot |
| MOB-13 | Gate `mobile:doctor` | integrado | `mobile/scripts/mobile-doctor.mjs` | — |
| MOB-14 | Superfície nativa de diff | pendente (G) | depende de medir MOB-02 | avaliar depois |
| ORC-01 | Outbox transacional + classes replay-safe | pendente (M) | só `handoff-delivery-outbox.ts` | `orch/effect-outbox*` |
| ORC-02 | Turno terminal ≠ efeito assentado | pendente (M) | sem supervisor de assentamento | depende de ORC-01 |
| ORC-03 | Checkpoint em ref oculta | integrado | `git/hidden-checkpoint.ts`; `orch/tools-checkpoint.ts:41` | — |
| ORC-04 | Recibo de comando com `resultSequence` | pendente (M) | sem `command_receipts` | com ORC-01 |
| ORC-05 | Handoff de contexto orçado | integrado | `orch/context-handoff-budget.ts`; `failover-mission-respawn.ts:30` | — |
| ORC-06 | Reconcile de boot do provider | pendente (M) | só `pane-start-watchdog.ts` | depende de ORC-01 |
| ORC-07 | Política steer/fork por capacidade | pendente (P) | sem tabela de política | tabela em `src/shared/` + spawn |
| ORC-08 | Drenar worker em teste | pendente (P) | testes usam fake timers/`waitFor` | junto de QLT-08 |
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
| QLT-02 | `KeyedLock` | pendente (P) | sem primitiva | só com consumidor real |
| QLT-03 | `KeyedCoalescingWorker` | pendente (M) | sem primitiva | só com consumidor real |
| QLT-04 | knip | pendente (M) | sem config | dep + CI |
| QLT-05 | `require-suppression-reason` | integrado | `oxlint-plugin-nexus/rules/require-suppression-reason.mjs` | — |
| QLT-06 | `no-test-in-loop` | pendente (P) | regra ausente | regra no plugin |
| QLT-07 | `no-raw-ipc` | pendente (M) | só `check-renderer-sinks.mjs` | regra AST |
| QLT-08 | `DrainableWorker` | pendente (P) | sem helper | junto de ORC-08 |
| QLT-09 | Paginação por cursor | pendente (G) | só gap buffer de terminal | histórico de missão |
| QLT-10 | Nome de ação = nome acessível | pendente (M) | só `check-palette-contrast.mjs` | check + guideline |
| QLT-11 | Telemetria só com assinante | integrado (parcial) | `perf/pane-footprint-broadcast.ts:27,91`; traps de PID/geração ausentes | traps em `pane-footprint.ts` |

## Limites desta auditoria

- Os estudos foram lidos do banco do projeto, porque a tool não lê handoffs de outra missão. As linhas do T3 citadas vêm dos estudos, não de releitura do upstream.
- Nada foi exercitado em aparelho, simulador ou navegador nesta auditoria.
- Licenças de `@pierre/diffs`, `@legendapp/list`, `nitro-markdown`, `@react-native-ai/apple`, `@napi-rs/keyring` e `@crowecawcaw/xa11y` vêm dos estudos e não foram reverificadas sem rede.

# Cobertura atual — integração Terminais, F-764 e publicação macOS

Auditoria somente de presença, chamadores, contratos e proveniência de evidências, em 04/10/2026. Árvore congelada: **`c38533bdfdb424d75ae6f76806bc3a0f7bb32f58`**, limpa na leitura. Nenhum teste, build, probe de credencial ou processo do operador foi executado por esta auditoria. Somente este arquivo ignorado foi escrito. Caminhos relativos abaixo partem da worktree `release-076191-final`.

**Conclusão: a integração extensa está presente e a suíte privada completa passou; ainda não há fechamento de todos os requisitos nem prova de uma nova release publicada.** Foi confirmado um gap adicional no caso original de N4. C6/F-875 continua parcial. Os gates nativos/assinados, a revisão independente do diff final e a publicação seguem obrigatórios.

Fontes de requisitos: `docs/analysis/2026-10-03-main-thread-hang/HANDOFF.md`, `docs/analysis/2026-10-03-missao-terminais/HANDOFF-INTEGRACAO.md`, `docs/analysis/2026-10-03-release-076191/PLAN.md`, `docs/RELEASE-CHECKLIST.md`, `~/nexus-incident-2026-10-03/{coverage-audit,review-ec8524a8}.md`. A antiga matriz `coverage-final-audit.md` é de **`ce22fbb0`** e foi usada somente para localizar itens; seus estados de WIP/probe de 6 s/N7/N9/C6 foram conferidos e substituídos pelo estado abaixo.

Esta unidade **não é revisão independente** dos patches C7/F-857, F-863 e Linux/F-869 escritos por este auditor. Para esses itens, registra apenas presença e evidência com seus limites; os revisores independentes e o candidato precisam fornecer aprovação própria.

## 1. Evidência e diferenças entre SHAs

| Ref. | Evidência conferida | Alcance exato e limite |
|---|---|---|
| E1 | `.superpowers/sdd/PLAN/private-verification-install.{json,log}`, `install-private-verification.mjs` | Instalação privada materializada por npm **12.0.0**, Node **22.23.2**, inicialmente em `5f5a45f4`; lock SHA256 `c04b05b31d5acff07f29f4e0726a66dce46f8f6b16fc6f6bba698e11d0f79ee2`. Script exige pasta `.noindex` sem node_modules, roda `npm ci`, exige diretório não symlink e lock inalterado. Não é instalação do app final. |
| E2 | `private-verification-location.json`, `full-private-6e968c1e.log`; processo Root **48052**, exit 0 informado pelo integrador | Fonte atualizada para **`6e968c1e405feb7016a112d7b4067a56853a838b`**. **1847 suítes passaram / 4 suítes skip; 21545 testes passaram / 53 skip**. Log confirma sinks **0** e ratchet **91** usos legados exatos. Comando serial do Root também incluiu check-node-natives, build universal ad hoc, tsc app e tsc server silenciosos. Recibo durável conferido: `full-private-6e968c1e-receipt.json`, observado exit0 do processo48052, etapas sequenciais com interrupção em falha; o tsc é silencioso. |
| E3 | `git diff --stat 6e968c1e..c38533bd` | Depois de E2: merge `34d085fb` somente site/cloud-api; atualização de documentação; F-877 altera **catalog.cjs/preload.cjs/native-heavy-preload.test.ts**. E2 não é uma suíte do HEAD final. Site/cloud-api têm runners separados e não entram na suíte app; o merge não constitui teste desses projetos nem publica seus serviços. |
| E4 | `native-bounded-and-servers-final.log`, Root: **4 suítes / 74 testes**, tsc/sinks/lint passaram | Regressão posterior de F-877 em **`c38533bd`**. Log preserva 74 PASS, sinks 0 e Sync91; comandos/exit do tsc silencioso são do integrador. Não substitui união após F-875/N4 nem smoke nativo. |
| E5 | `docs/analysis/2026-10-03-release-076191/evidence/load-f863-normal-poison/manifest.json` + métricas/profile/barriers/analysis-final/logs | Carga Main de produção + **host de créditos falso**, Worker real; normal fonte `9571a5b3`, poison `13398f61`, harness WIP identificado no manifesto. Não é fonte final nem candidato assinado. Hashes dos arquivos preservados. |
| E6 | Normal E5: 30.097 s; **251243729 bytes**, **8.348 MB/s**, p99 **9.404 ms**, max **182.269 ms**, spawn bloqueio **19.218 ms**, 289 scans | PRONTO=`done`, 1 handoff, 1 OSC concluído, checksums iguais, barriers true, `degradedSessions=0`, `lastFailure=null`, admitted=acked=received. 15 sessões iniciais + spawn concorrente. Valores não extrapolados para host nativo. |
| E7 | Poison E5: 30.009 s; **10037001083 bytes**, **334.466 MB/s**, p99 **8.757 ms**, max **106.676 ms**, spawn bloqueio **31.068 ms**, 293 scans | Worker envenenado saiu fisicamente; 16 sessões degradadas, epoch2; barriers false somente nessas sessões e true na nova. Nova sessão completa PRONTO/handoff/OSC e EOF. `lastFailure=work-timeout` e admitted≠acked das sessões antigas são degradação explícita, nunca flush bem-sucedido. |
| E8 | `review-n7-n13.md`, `review-mimo-usage.md`, `review-native-command-final.md`, `review-owned-command-integration.md` | Revisões independentes **parciais** com SHAs próprios. Achados subsequentes F-858..861/F-871..876/F-880 têm correções em fonte/fixtures; F-875 permanece. Nenhum desses relatórios aprova o diff final inteiro. |
| E9 | `.superpowers/sdd/PLAN/snapshots/manifest.json` | **17 entradas** de worktrees, **5 tracked.patch** com SHA256; memória também preserva 3 untracked. Integração/cherry-picks foi conferida pelos chamadores atuais, não pela mera existência dos snapshots. Preservar branches/WIP/dados é parte do contrato. |

E2 cobre os testes comuns listados nas matrizes quando não condicionados por plataforma/flag. **53 skips não são aprovação** de Linux/Windows/packaged/native/carga opt-in; os casos `runIf(F764_WORKER_ENTRY)`, Linux bwrap e requisitos assinados precisam de seus receipts próprios. Logs antigos `private-native-and-server-checks.log` contêm a falha histórica F-879, já corrigida; `private-server-fixed.log` prova build e smoke do artifact server. Não foi reclassificada como falha atual.

Estado externo/WIP conhecido **fora do congelado**: F-875 watcher físico autenticado + cobertura restante de CLIs + warmup/await no Main; correção N4/F-833 iniciada pelo Root após esta auditoria; recibo E2 durável conferido e registros F-802/F-815 em preparação. Não há SHA final desses itens no congelado; avanços posteriores estão na seção8. F-877 externo `8df61586` **já foi importado como c38533bd**, deixou de ser pendência de integração.

## 2. Revisão original: cada C/A/M/B

`I+E2` significa fonte/chamador presente e regressões comuns abrangidas pela suíte privada de `6e968c1e`; ainda exige revisão final. `P` significa parcial, com gap identificado. Casos de campo são separados dos testes de fonte.

| ID | Estado | Código/chamador atual e regressão significativa | Prova ainda necessária |
|---|---|---|---|
| C1 | I+E2 | `operator-hand-mission.ts:41` compila standard por padrão; `renderer-mission-authority.ts:834` adota sem classificador de texto. `tools-domain.ts:377` é o opt-in estreito de sync. Testes de adoção real com gate/stores e títulos Deploy/Auditoria/análise afirmam budget e spawn, não apenas lane. | Smoke de +Pane→delegação→helper→handoff no candidato. |
| A1 | I+E2 | `task-router-quality`, `task-router-review-floor`, `search-mixer-bootstrap`, `hook-integration-endpoint` estão na união verde. Argon gated, vault default off, Git hermético com main explícito. | Revalidar delta posterior; não repetir a classificação antiga de 12 reds como pré-existentes. |
| A2 | I+E2 | `hook-integration-endpoint.ts:78–91` reconhece merge exato e controles abort/quit/continue; `integration-review-gate.ts:52,200` identifica MERGE_HEAD por worktree. Testes executam abort em conflito real e preservam gate de push/merge composto. | Revisão final preservando autoridade do HEAD e composição. |
| A3 | I+E2 | `workspace-memory.ts:723,989` exporta vault só opt-in; `tools-memory.ts:92,205` impede vault do retain read-only/consult; projeção padrão vai a userData. F-806/F-808, testes de opt-in/consult/read-only. | Smoke com projeto privado; nenhuma permissão para escrever perfil/checkout real automaticamente. |
| A4 | I+E2 | `workspace-memory.ts:684,739,989,2384`: export async/incremental/debounce, raiz fixada por `memory-coordination-authority`; bind Main/registry. Testes volume2000, raiz, concurrent flush e shutdown. | Carga/heap final; fixture de volume não é SLA do banco real. |
| A5 | I+E2 | `mission-intent.ts:1035,1147` `isExplicitGitSyncGoal` limita vocabulário/texto completo. Deps/README/actions/issues/API/investigação não viram ops. `mission-delivery-artifact-gate.test.ts` mantém exigência de arquivo de escrita. | Wizard + done operacional no candidato. |
| M1 | I+E2 | `workspace-memory-context.ts:124` somente operador/promoted ou fonte canônica agent-authored ligada à mesma missão, sem quarantine. `observer-mission-event-projector.ts:90` registra exposição ANTES do retorno mission-only; `session-web-exposure.ts:17` inclui shell-http e overflow conserva quarentena. Import prefix/texto Mission não ganha confiança. | Revisão adversarial final da fronteira; app não deve promover memória de página por aparência de autoridade. |
| M2 | I+E2 | `operator-cli-mentions.ts:65,187` typos explícitos, sem edit-distance arbitrária. Negativos mude/mouse/devia/memo/mito/table/clause/cursos; positivos qwhen, digitação/backspace e input humano. | Transporte humano real e receipt de escolha no smoke. |
| M3 | I+E2 | `task-router.ts:1152,1169` busca exige verbo/objeto explícitos. `task-router-capabilities.test.ts` compara mesmo bug com/sem “versão atual” e pedido real “pesquise na web”. | Inventário real e rota no candidato; dado atual sem verbo não é capacidade provada. |
| M4 | I+E2 | `failover-mission-respawn.ts:105` Async Process Git Runner com config segura, timeout1 s/consulta, diff sem driver/textconv; planner puro. Só execução própria diferente da coordenação. Testes no-Sync, malicious config e scope. | Troca de contas/CLI real, preservando login do operador. |
| M5 | I+E2 | `guided-greenfield-brief.ts` escreve v3 e aceita v1/v2/v3 byte-canônicos; fixture literal anterior e bootstrap real. `guided-greenfield-brief.test.ts:83,121` cobre versões legadas, não só roundtrip novo. | Boot de projeto legado no pacote final. |
| M6 | I+E2 | `task-router.ts:596,1521,1579` Argon exige live Models e fora de quarantine; critical security só Claude/Codex, ou judge Unavailable. Testes judge-lane + review-floor/quality mantêm políticas registradas. | Acesso real nunca inferido do catálogo; revisar rota final. |
| M7 | I+E2 | `turn-end-handoff.ts:304,327` admissão só fechamento/verbos de entrega; `jev-handoff-review.ts:541` weak sem bounce Signals espelha MCP. F-823 cases “não reproduzi antes, agora passou”, pendência real e parity. | CLI sem MCP real; N7 continua obrigação adicional de captura, não prova por prosa. |
| B1 | I+E2 | `tools-panes.ts:2042` somente `peekCodexCliVersion`; sondas async fora do spawn quente. Cold-cache/no-Sync testes. | Bloqueio Main <100 ms no SHA final, sem confundir spawn wall time. |
| B2 | I+E2 | Hook usa Async Process Git Runner (`hook-integration-endpoint.ts:49`), gate async; F-822 e worktree Git também async. F-815 fonte presente; ratchet91 passa. | Registro QA F-815 ainda ausente no congelado; Root prepara. |
| B3 | I+E2 | `pricing.ts:233–234`: variante paga Open Code Deep Seek Flash tem custo; só -free zero. Catalog/deprecated/API-only fences preservados. | Atualidade de preços não foi pesquisada nesta auditoria; dados estimados não viram medição de custo/acesso. |
| B4 | I+E2 | `mission-work-kind.ts:174,186,300` falha verbal vence substantivo inventário; testes inventory crash vs audit/read-only. | Smoke pertinente; esse predicado de design não substitui requisito visual de UI-bug. |
| B5 | I+E2 | `task-router.ts:1610,1622,1657` exclui security da rotação/fair-share; test 3 dispatches segurança no líder, bug comum diversifica. | Classificação/Jev real e revisão final; multiscore mantém sua penalidade independente. |
| B6 | I+E2 | Adoção afirma efeito max Workers/spawn, literal v1/v2, Git hermético real, negatives CLI/web, provider account receipt + spawn fixado; testes antigos atualizados ao Worker/off Main e awaits físicos em `1fc357ff`. | Testes não substituem contas/aplicativo nativos; N4 ainda tem fixtures que aceitam resumo em full Text. |
| B7 | I+E2 / docs parcial | F-769/F-778 apontam F-839..844 e F-845/846, cada causa em arquivo próprio; ponteiros/histórico preservados. | F-802 e F-815 ainda sem arquivos próprios no congelado. Root prepara rastreio; split documental não cria prova nova. |

## 3. N1–N14: nenhum requisito é reduzido por skip

| ID | Estado no congelado | Fonte/chamadores e testes conferidos | Limite/gate |
|---|---|---|---|
| N1 | Resolução aceita, segura | `squad-runtime-policy.ts:36,88`, `tools-instruments.ts:817`, F-834 dizem worktree≠sandbox. Hardened exige capacidade nativa provada; operator-choice mantém a autoridade vigente. Test não afirma Kimi nativo a partir de capacidade fake. | A resolução documentada foi aceita; **não é suporte Hardened multi-CLI novo**. Não relaxar gates para fingir esse suporte. CLIs sem capacidade nativa continuam honestamente recusadas nesse modo. |
| N2 | I+E2 | `cli-model-discovery.ts:27,52` compara client_version com cache do binário resolvido; versão desconhecida/inválida/newer recusa cache; hidratação invalida após mudança. Testes produtor160/consumidor146 e igual/legado. | Smoke binário/cache real; nenhum probe Sync novo. |
| N3 | I+E2; credencial externa | `qwen-readiness.ts:88`, cache TTL; `provider-config-store.ts:1894–1937` propaga rejeição; `seat-auth-readiness.ts:59` exclui; `tools-domain.ts:1851` e inventory transportam estado. Testes401/redirect/host/cache+route. | Qwen401/login/disabled são limites do operador, não autorização de trocar segredos. Rede unknown não confirma invalid. |
| N4 | **P: gap original reproduzível por leitura** | `pane-close-scopes.ts:80–99` impede sucesso sem report mas aceita qualquer full Text não vazio, inclusive igual ao summary. `tools-handoff-workspace.test.ts:144,151` usa full Text=summary e aceita. QA F-833 declara ausência corrigida; original N4 era resumo de756 bytes disfarçado em full Text. | Root confirmou e reabriu **mesmo F-833**. Exigir preserve tail Main sanitizado/procedência antes de close, ou recusa explícita que conserve pane quando full Text≈summary; regression MCP/PTY/workspace + leitura do artifact durável. Hash/test pending fora desta base. Não chamar resumo/tail de relatório completo. |
| N5 | I+E2 com resolução registrada | `resources/model-catalog.json`, `model-catalog.ts:75`, builtin Claude default Sonnet5.5; testes fresh default/stale catalog explicit pin. F-828 mantém descoberta/promoção/quarentena/recovery em vez de inventar versão mínima. | Não há claim de preflight por versão exata nem teste de campo com binário antigo; validar comportamento de recusa/recovery real e não transplantar login. |
| N6 | I+E2 | Mesmo F-822/M4; Git assíncrono/config/escopo/timeouts e no-Sync. | Campo de failover + lint final. Não contar duas vezes como causa distinta. |
| N7 | I+E2, prova final pendente | `visual-handoff-gate.ts:25,33,94` requisito UUID Main, inclui UI-bug, ledger exige assignment/session/incarnation/root; `tools-browser.ts:285,305` somente capture autorizada da atribuição atual. BrowserArtifactStore verifica arquivo/hash. MCP/PTY/workspace convertem falta em partial e não avançam task/auto-close. Regressões reuse equal-clock/ABA/scope/tamper presentes. | Receipt prova existência/procedência, não qualidade visual. Captura e inspeção reais no candidato; não aprovação independente pelo autor desta auditoria. |
| N8 | I+E2 | Brief v3 + manifesto gerado `stack-advisor-manifest.ts` nomeiam `.context/docs/stack-decision.md` / `nexus_context_draft_propose`; testes legacy/bootstrap/skill. | Fluxo draft→independent review→apply continua dono; instrução não aprova stack nem autoriza escrita direta .context. |
| N9 | I+E2 | `mechanical-sensors.ts:462`, `sensor-broker.ts:66`; consumer `civilian-auto-review.ts:371` revalida autoridade e :240 exclui advice de vetos. Até24 deps públicas npm,64 KiB,1.5 s/query,7 s total; sem npmrc/token/redirect. Testes obsolete/deprecated/offline/private/sem mutação e achado critical forjado. | Advisory, outras fontes/locks/offline unverified; nenhum update automático. Não omitir requisito por antigo “opcional”. |
| N10 | I+E2 | `operator-input-receipts.ts:91`, transporte real `pty-manager.ts:3806–3808`; UI humana `orch-ipc.ts:1838`; observer sanitizado guarda human/system/unknown e writer finito. Hook :701 usa recibo Main para memória. Testes TTL/session/cursor/system/exit/incarnation/maestro/failover. | Sem prompt/argv/fingerprint no journal; ausência=unknown. Turnos e escritas reais precisam smoke. |
| N11 | I+E2 | `TraceFileSink` separate lifecycle diária14 dias completos+atual, trace por tamanho separado; queue bounded/reserva/failed+dropped visíveis. `main-trace.ts:73,88` flush/history; Main quit espera. Test rollover/prune/drop/drain. | Não promessa de storage infinito/14 dias operacionais já vividos; prova final de flush/quit e redaction. |
| N12 | I+E2 | `mission-pane-resume.ts` captura spec/conversation Main exatos antes de route; `tools-panes.ts:1036` usa no caminho missão. assertCurrent após awaits, headless copy/exactResumeRequired; ACP sem resume recusa. Testes Muse sem adapter, mismatch/foreign/deleted/mudança de conta/worktree. | Perfil/conversa ausentes recusam, nunca fresh fallback. Campo com contas reais separado. |
| N13 | I+E2 + autorização | `managed-worktree-layout` raízes novas macOS .noindex, legacy accepted, Linux/Windows invariantes; `NOINDEX-PROPOSAL.md` registra autorização explícita. Testes new/legacy/WIP/candidate/outside. | Nenhum caminho antigo movido/apagado; nenhuma claim causal Spotlight. Efeito de indexação é medição externa, não requisito de atribuir causa do hang. |
| N14 | Artefato/doutrina entregue +E2 | `08-pesquisa-memoria.md` íntegro com fontes/comparação ai-memory/Akita/Graphify/Obsidian; `workspace-memory-context.ts:16` MEMORY_RETRIEVAL_DOCTRINE + `tools-memory.ts:230`. F-801 união FTS/relações já cacheadas. | **Sem engine graph/vector nova, embedding ou benchmark novo**. D1 specialty overlay vazio e D2 ranking fixture declarada permanecem decisões por ausência de medição, não bugs nem licença para fabricar ranking. |

## 4. Itens explicitamente pendentes no handoff de integração

| Item | Código operacional e testes atuais | Estado/prova |
|---|---|---|
| F-798 | `workspace-memory-service.ts:22–26` iniciado pelo registry; replay em lotes de4/keyset/proveniência aceita; `workspace-memory-backfill.ts`; IPC native-memory-import bounded/nofollow/short-read + UI. | I+E2. Restart/dedup/retry/scope/import quarantine/promotion testes; nenhum perfil nativo importado automaticamente. Campo da importação explícita no smoke. |
| F-799 | Hook :701 exige prova humana; operator-preference-memory busca limite64K + janela Jev de1500 caracteres; memory-ipc attestation Main e explicit global scope. | I+E2. Long human vs injected/quoted/negated, attestation/sender e UI; prova de operador não vem de AGENTS editável. |
| F-800 | `workspace-memory-maintenance.ts:11` produção expira só digest nunca injetado >30 dias, páginas/cursor de16 fatos e32 relações; serviço por minuto/open/rodízio, stop awaited pelo registry. | I+E2. Fronteira estrita, restart após primeira página, arquivo restaurado e shutdown físico; nenhuma decisão/regra/preferência expira. |
| F-801 | `workspace-memory-context.ts:373` lexical+recallLinked; `memory-impact-recall.ts` blast-radius cache/checkout atual/30 min; dedupe/trust/bytes/contador de injeção. | I+E2. Fact com zero overlap lexical recuperado via file; stale/missing/foreign fallback FTS, quarantine; nenhum rebuild de graph no caminho quente. |
| F-802 | `operator-hand-context.ts` identidade + channel; MCP initialize `mcp-protocol.ts:206`; Codex/Kimi hook `hook-delegate-endpoint.ts:440,746,823`; demais MCP; helper spawn `tool-util.ts:1288,1317`. Operator-workspace-memory/hook testes cobrem Claude/Grok/Kimi/Codex/promotion/dedupe/off. | I+E2 fonte; **QA individual ausente** no congelado, Root prepara. Matriz de canais estrutural não é smoke real de TODAS as CLIs. |
| F-810 | C1 standard para hospedar helpers/adoção real + `tools-domain-mission-authority` Autopilot/Hardened/tab testes. | I+E2; candidato ainda. |
| F-811 | A5 sync vocabulário inteiro / gate de artifacts negativos e ff positivo. | I+E2. |
| F-812 | M5 brief com marcador de versão literal legacy v1/v2+v3. | I+E2. |
| F-813 | B4 verbo de falha vence estoque/inventário. | I+E2. |
| F-814 | A2 conflito real/controles/plumbing; push continua com gate. | I+E2. |
| F-815 | B2 hook/Git de integração async; read-only parsing/cwd/HEAD atual/config/ff testes. | I+E2 fonte; **QA individual ausente**, Root prepara. |
| F-816 | Hermetic Git fixture init -b main, autor fixo, global/system config disabled, tmp HOME; runner de produção preserva autoridade. | I+E2 correção de fixture, não novo defeito produto. |
| F-817 | M6 Argon prova de acesso/segurança crítica + ranking política sem frontier. | I+E2. |
| F-818 | M2 aliases exatos/lista limitada de typos; negativos de digitação humana. | I+E2. |
| F-819 | M3 filtro de capacidade web explícita; negativos de bug comum. | I+E2. |
| F-820 | B3 Flash pago e free com preços distintos. | I+E2; catálogo não é probe de disponibilidade/preço live. |
| F-821 | B5 security fora de rotate/fair-share; bug comum continua diverso. | I+E2. |
| F-822 | M4/N6 planner puro/Git async seguro só na execução própria. | I+E2. |
| F-823 | M7 admissão só no fechamento; weak com paridade MCP/PTY. | I+E2; N7 é obrigação visual adicional. |
| F-773 / F-782 | Handoff ACK grava verdict+decisionId e feedback Jev; route attribution físico+exit fallback, outcome14dias/amostra mínima5; route-decision-ledger durável30dias/5000linhas. Testes route-outcome/feedback physical ACK/persist restart. | I+E2. Não taxa por specialty inventada nem atribuição retroativa histórica sem sessão. |
| F-775 item2 + pack do renderer / F-765 | `pane-task-reroute`, failover/model-quarantine/respawn Main; renderer failover-controller continuity; next CLI quando todas contas esgotam. Testes switched só após await de spawn e autenticação, nenhuma alternativa elegível/anti-loop/escopos de conta. | I+E2. Teste campo duas contas Claude e CLI fallback ainda obrigatório; não alterar credencial para realizá-lo. |
| F-797 / F-780–781 | Worker browser tools allowlist leitura/capture; tools-browser pedido de pane ao Main; browser-first directive e hook; observer nome da tool/kind/shell-http/nome da skill. Testes gate/transport/workspace alheio/mensagem de fallback. | I+E2. Navegador worker real no pacote e captura N7 pendentes. Sem universal allowlist de controle/click para read-only. |
| F-795 | Spool por sessão assinado, handoff-submit-inflight/recovery e route de entrega; pretool com Main inacessível não bloqueia leitura. Testes replay/identity/size/stale/scope/idempotence. | I+E2. recuperação após hang do Main assinado/entrega durável ainda a provar. |
| Async-IO / MiMo | Git/worktree/check-ignore async; peek de versão quente; Codex sem trust-bypass no boot. Usage MiMo isolado e followups F-858..861; `main.ts:754` aguarda initUsageTelemetry e shutdown drena. | I+E2. Checks locais/fixtures não provam cancelamento nativo de SQLite e candidato final. F-875 warmup é unidade distinta ainda pendente. |
| F-766..794/F-796 já integrados | Operator CLI/pins, memória retain/recall, diversidade/capability/skill, catálogo/charter/stack, grafo da missão, Jev/Clef surfaces, orçamento paralelo de RAM, semantic handoff, watchdog de boot/Qwen/MiniMax/agy flags, writer isolado commit+salvage e ranking/toolpick toggles possuem código/testes na união. | E2 dá regressão de fonte; oito pedidos do operador continuam sujeitos ao smoke real e release. Não se resumem à existência de F-records. |

## 5. F-764 completo, incluindo aceite

| Req. | Implementação atual e evidência de fonte | Estado de aceite e prova decisiva |
|---|---|---|
| A.1 | `hang-watchdog-worker.cjs:435` usa connectToMainThread/Profiler, `.cpuprofile` e frames por amostras próprias com função/URL/linha. `smoke-hang-probe.ts:21` induz **40000ms**; harness v2 lê profile real e recuperação do episódio. | E2 fixtures. **Developer ID/hardened, fuse inspect OFF e profile durante40s no binário final pendentes.** Electron/ad hoc/6s históricos não substituem. |
| A.2 | Worker append em `main-hang.ndjson`; `runtime-context.ts` envia últimos32 eventos, tarefas periódicas ativas, contadores e bytes/s por sessão, trace e heavy pool; contexto ≤64KiB independente. | E2 testes. Provar segundo episódio append e snapshot pré-hang utilizável no packaged40s. Sem terminal/prompt/paths brutos no contexto. |
| A.3 | Event-loop monitor p50/p99/max a cada30s; dispatcher cronometra taps nomeados >50ms/batches >100ms, callback instalado e snapshots. | E2+carga E5 histórica. Timings do SHA final/host nativo pendentes. |
| B.1 | `pty-analysis-main-load.test.ts:84,248–265`:15 sessões, ≥5MB/s, Main/stores/supervisor reais, spawn roteado concorrente, profile/barriers/checksums/EOF. Normal exige zero degradação; poison exige recuperação da geração nova. CI :76–100 configura30s, Worker, regex, poison e artifacts. | E6/E7 passam em SHAs anteriores/host falso. **Repetir SHA final com bundle novo e equivalência nativa/assinada**, sem reduzir throughput/semântica. Skip opt-in de E2 não encerra. |
| B.2 | HANDOFF documenta H1/H3: regex cúbica em TUI branca no limit-detector; janela4K linear/backoff25ms, medição histórica301ms→0.13ms. | Causa histórica fechada; profile final é outro gate. Não atribuir causa ao Spotlight. |
| C.1 | PTY16ms batch/credits e PtyAnalysisCore/Worker dedicado para detector/failover/OSC/URL/paste/token/pipe/handoff/autoresponder; efeitos e fences sessão/generation/seq no Main. F-863 preserva250ms de trabalho ativo e2s startup/delivery com SAB por job exato. | E2+E5 Worker real/host falso. Presença, sem revisão independente pelo autor. Worker/asar nativos e stress final pendentes. |
| C.2 | Fila justa por bytes limitada,512 descriptors, host credits, ordem EOF e replay/UI completos. Poison degrada explicitamente, sem fallback Sync; ACK atrasado no Main não vira falso work timeout. | E6 admitted=acked=received/hashes; E7 barriers false das antigas e semântica nova. Credits/EOF físicos nativos e limites de memória finais pendentes. |
| C.3 | Janelas limitadas/compiler/evaluator; `regex-adversarial-worker.ts` inventaria19 arquivos com literals + manifests compilados; cinco shapes1MB nas janelas reais/parity. Deadline externo250ms termina poison real. | Inventário do domínio de detecção, **não toda regex do repo**. E5 regex histórico e CI presentes; relatório final com contagem/timing/shapes/compiladas/fault exigido. Fullsuite condicionada não prova isso. |
| C.4 | runPeriodicTask/periodicCallback: singleflight físico, checkpoint/yield10–20ms, current/cancel e stops aguardados; `PERIODIC-MAIN.md` descreve inventário e passos atômicos. FS/Git/catalog/scanners async, usage init aguardado. | E2 regressões. Wrapper não preempta chamada nativa atômica SQLite/Electron/FS. Stress/quit final valida métricas e drain; warmup/await F-875 ainda externo. |
| C.5 | Git async em worktrees/check-ignore/failover/hook; `check-main-sync.mjs` AST/alias/import/member ratchet fail-closed acionado em package/prepackage/premake/lint/CI; **91 usos legados exatos**. | E2/E4 passam. Reexecutar após deltas finais; não alegar zero fsSync/processos legados Sync. |
| C.6 tools MCP | `tools-terminal.ts:248,269,354` / `tools-bg.ts:197,217,276` adquirem por projeto/RAM e vinculam waitForExit imediatamente. Darwin coorte, Linux PID1 fixado+outer close, OCI identidade+saída física; cancel conserva unknown. F-868/869/870/880. | E2 fixtures e revisão parcial. **Plataformas reais, descendentes/setsid/cancel/shutdown/lease no candidato pendentes.** Mac fake kernel não aprova Linux/Windows. |
| C.6 native CLI | Token/sessão Main + claim kernel, catálogo shell/Node/prehook, nested borrow só com posse física; F-871..874/876 fences/drain. F-877 exclui servidores persistentes, **integrado**, E4 passou. | **Parcial/F-875 aberto:** amostragem legada não prova descendentes breves/reparentados; watcher forte + warmup/await externos; `/bin/sh` e cada CLI/transporte precisam prova real. Claude fixture não encerra C6. |
| C.6 workers/RAM | parallel-helper-budget/memory pressure/cache/swap, worker admission/reservation, isolated writer e contagem de pendentes vivos; comandos serializam por projeto enquanto LLM trabalha em paralelo. | E2 regressões; paralelismo real15CLI/RAM/swap/cancel/quit final. Sem missão não infere humano; shells humanos sem endpoint ficam fora da autoridade AI. |
| C.7 | Main heartbeat trivial e MainBusyBanner após10s sem auto-kill; smoke separado **renderer montado/Main real40s**, observer preload e contrato privado, `--verify-busy-banner-probe`. Nonce/wc/mainframe/perfil privado, dois frames visíveis, limpeza antes do funcional. | E2 testes. Candidato assinado deve gerar acceptance.json, frames+clear, profile do mesmo episódio, funcional após recuperação e quit gracioso sem órfãos. DOM não prova pixels/qualidade; presença do autor não é revisão independente. |

E5 tem limitação textual antiga “hard-watchdog fault run pending”; E7 já prova fault do Worker real nesse harness. O limite **host nativo assinado/SHA final** permanece.

## 6. Release checklist — cada caixa macOS

Os itens pendentes exigem receipt do mesmo SHA e dos mesmos bytes do candidato final. Testes JS que imprimem `[smoke] renderer-mounted` com mocks não executam o aplicativo; essas linhas no full-private não provam packaging nem smoke real.

| ID / caixa | Estado atual | Prova decisiva |
|---|---|---|
| PB1 instalação limpa | E1 passou em ambiente privado | Receipt associa instalação, lock inalterado e fonte final. |
| PB2 rebuild Electron + Node | Check Node e helper universal ad hoc em E2; Electron pendente | Rebuilds privados na cadeia final, ABI do artifact e restauração de Node no ambiente de build. |
| PB3 tsc app | E2/E4 passaram | Recibo durável E2; gates após F-875/N4. |
| PB4 renderer-sinks | E2/E4 passaram, 0 sinks | Repetir após delta final/prepackage. |
| PB5 changed/trusted regression | E2: 21545 PASS/53 skip | Gate da união final/delta e inventário explícito de skips. |
| PB6 make chega ao artifact | Pendente | Log exit0, caminho e hash do artifact. |
| BP1 DMG em out/make | Pendente | DMG final gerado, montado e aberto. |
| BP2 ZIP extrai e abre | Pendente | Validação de paths/symlinks e smoke do app extraído desse ZIP. |
| BP3 assinatura/notary | Pendente | Developer ID, team, hardened, entitlements, notary accepted, staple e Gatekeeper. Ad hoc não vale. |
| BP4 native modules/Mach-O | Check Node não prova o app | Inventário e carga node-pty/sqlite/onnx; arquiteturas e minos de cada artifact final. |
| BP5 CSP/contextIsolation | Fonte e testes em E2 | Conferir bundle e preferências da janela assinada sem relaxamento. |
| SA1 sem preload crash/renderer branco | Testes de fonte | Launch real do ZIP final, mounted e probes funcionais. |
| SA2 Launcher renderiza | Testes de fonte | DOM/captura e probes distinguem launcher de título/idle/erro. |
| SA3 workspace/terminal input | Pendente campo | Workspace privado, input/echo, resize e resposta. |
| SA4 missão ops inicia/para | Pendente campo | Missão ops sem workers, início e stop reais. |
| SA5 standard 1–2 workers/handoff/stop | E2 estrutural | CLIs autorizadas reais, spawn, handoff, ACK e stop sem crash. |
| SA6 Settings/providers | E2 mocks | Renderer final lista providers sem erro de bridge; inválidos transparentes. |
| SA7 Cmd+Q sem órfãos | F-862/F-865 fonte | Inventário físico zero de PTYs, sidecars e jobs nativos após quit gracioso; reap externo não conta como sucesso. |
| SC1 logs sem conteúdo sensível | Testes de fonte | Review final e logs do artifact sem tokens/chaves/paths home sensíveis. |
| SC2 sem keys/env no bundle | Audit final pendente | Scan do diff e bytes empacotados, sem expor segredos no output. |
| SC3 keychain/safeStorage | E2 fixtures | Segredos em repouso no app final via mecanismo existente e perfil privado. |
| SC4 MCP embutido autorizado | Política de fonte | Config privada final aponta ao server embutido; nenhuma URL remota não autorizada. |
| SC5 entitlements/Seatbelt/processHome | Fences de fonte | Entitlements codesign e probe de confinement, sem enfraquecer fuse inspect. |
| MP1 grid/MAX sem panes fantasmas | E2 fonte | Múltiplos panes reais com contagem física coerente. |
| MP2 mover pane sem respawn | E2 fonte | PID/startKey/session estáveis ao mover entre splits/espaços. |
| MP3 recovery de worker morto | E2/F-792/F-765 | CLI real recupera sem reiniciar app ou trocar autoridade. |
| MP4 pergunta/retry | E2 fonte | Pergunta registrada visível; retry não a apaga sem answer. |
| MP5 STOP preserva histórico | E2 fonte | Runtime físico termina, missão e handoffs permanecem duráveis. |
| PR1 heap limitado por 5 min | Pendente | Timeline heap/RSS Main+renderer em uso por 5 min; carga30s não substitui. |
| PR2 sem leak pane/session | Pendente | Abrir/fechar/trocar workspaces, inventário físico e contadores limitados. |
| PR3 microfone liberado | Pendente | Voz start/stop real e dispositivo liberado em perfil privado. |
| RC1 endpoints produção | Config de fonte | Sentry/update/API corretos nos bytes finais, sem secrets. |
| RC2 auto-update/feed | Fonte/harness | Feed canônico/espelho, arquitetura e versão corretos. |
| RC3 debug/test flags | Guards de fonte | Logging/devtools/testes guardados; launch normal não induz hang; fuses de produção. |
| RC4 package/plist/título | package0.76.191, Info final ausente | Reconciliar canal/tag antes do build; três versões e receipt iguais. |
| LI1 THIRD-PARTY-LICENSES | Inventário final pendente | Electron, sqlite, lydell/node-pty, onnx, xterm, xyflow, uiohook, Silero, piper e whisper cobertos no artifact. |
| LI2 origem/licença dos assets | Inventário final pendente | Fontes/ícones/som/modelos com proveniência; licenças npm não bastam. |
| RR1 riscos nas release notes | PENDENCIAS reconhece gates | Notas finais sem claims indevidas F-764/C6; todos os achados resolvidos ou com disposição registrada. |
| RR2 workarounds/decisões | N1/N13 registradas | Nenhum requisito pendente escondido como workaround; limites externos honestos. |

Gates adicionais do PLAN/handoff: security/audit/SBOM, revisão independente do diff completo contra `32230db8`, changelog/release notes, merge Main/tag final, receipt do candidato, publicação canônica e espelho e hash do download permanecem sem aceite nesta auditoria. Existência de `release-security-gate`, `release-candidate-gate` e `publish-release` não é execução.

Canais independentes preservados, sem downgrade:

- Windows W1 workflow/tag em main; W2 assinaturas HIPERSEND/timestamp de Setup/app/Update/ExecutionStub; W3 instalação limpa e upgrade; W4 SHA/receipt/três assets; W5 NUPKG/RELEASES/arquitetura; W6 monotonicidade do canal; W7 CKA.
- Linux L1 workflow/tag em main/Ubuntu22; L2 DEB/RPM/ZIP/receiptv2; L3 DEB instalado e ZIP aberto/Xvfb/paths/rpm dependencies; L4 publicação com bytes verificados em canônica e espelho; L5 bubblewrap instalado; L6 monotonicidade/no auto-update; L7 preview registra SHA sem ser candidata; L8 Omarchy/Hyprland se anunciado.

Não há aprovação real desses canais nesta auditoria. A publicação solicitada é macOS DMG/ZIP; checks de outro canal não substituem a prova macOS nem autorizam mudar perfil por plataforma indisponível. Linux/OCI precisam de testes reais próprios antes de alegar suporte físico.

## 7. Gaps numerados para fechamento sem sobras

1. **N4/F-833:** na base congelada, `fullText===summary` curto podia fechar e destruir a única resposta completa. Correção posterior `07096c9a` registrada na seção8; ainda exige revisão independente e gates finais. Não fechar N4 somente pelo teste de resumo ausente.
2. **F-875/C6:** integrar watcher forte autenticado, warmup aguardado no Main e cobertura dos transportes CLI restantes. Provar processos breves/reparent/setsid, RPC tardio, epoch e shutdown sem liberação falsa; preservar sandbox e reserva em unknown. Registrar SHA da entrega; ela não existe em c385.
3. **F-802/F-815:** registros QA individuais ausentes no congelado; Root prepara rastreio de uma causa por arquivo com spec/source/test provenance. Fonte já integrada; ausência documental não é novo defeito de produto.
4. **Receipts/gates do SHA final:** E2 é `6e968c1e`, E4 é delta F-877. Congelar após correções, registrar comandos/exit/lock/diff e executar gates pertinentes à união. Não contar53 skips como aprovação; listar os requisitos opt-in/plataforma e sua evidência própria.
5. **Revisão independente completa:** E8 não aprova a união inteira. Revisar fonte, efeitos dos testes e autoridade e corrigir achados. Presença registrada pelo autor C7/F-863/Linux não é parecer independente.
6. **F-764 B/C1–C5 final:** bundles novos de Worker e regex;15 PTYs, ≥5MB/s, supervisor/spawn/profile; normal preserva bytes/EOF/PRONTO/handoff/OSC/barriers e não degrada; poison prova morte física, false esperado nas sessões antigas e semântica completa na nova. Exigir p99<100ms, max<1s e bloqueio de spawn<100ms. Artefatos com hashes e SHA, sem extrapolar fonte histórica ou host falso.
7. **C6 físico no candidato/CLIs:** dois comandos do mesmo projeto serializam; projetos independentes/RAM/nested borrow/cancel/timeout/quit coerentes; servidores persistentes fora da fila. Reservas unknown só liberam após descendentes fisicamente mortos. Close de cliente bwrap/Docker ou amostragem PPID não bastam. Fixtures Mac não aprovam Linux/Windows.
8. **A.1/C7 assinados40s:** ZIP final Developer ID/hardened/notary/fuse OFF. Probes early e banner montado em HOME/TMP/userData privados; profile independente do mesmo episódio com função/URL/linha, Main real40s, dois frames visíveis e remoção, funcional após recuperação e quit gracioso sem órfãos. Nenhum app/processo/config do operador.
9. **Checklist/security/licenças/5min:** fechar cada PB/BP/SA/SC/MP/PR/RC/LI/RR; SBOM/audit/native ABI, ops/standard/recovery/browser/memory/resume/multiconta, heap5min, microfone e quit físico. Credenciais externas não autorizam alterar login: registrar precisamente o campo não executado, sem afirmar PASS.
10. **Versão/tag/main/build/publicação:** owner valida remoto atual antes da tag; taglocal191 antiga não prova final e não deve ser reescrita. Merge aprovado e tag no SHA exato, DMG/ZIP assinados/notarizados, release:candidate receipt/hash. Publicação via script canônico, preservação de assets anteriores, confirmação canônica+espelho/download/hash/receipt/feed. Só concluir a meta após publicação realmente provada.

Esses gaps não são encerrados pela passagem da suíte privada nem pela presença de scripts. A matriz dá a régua de fechamento; não certifica a release.

## 8. Atualização posterior à base auditada

Após congelar c38533bd, Root entregou **`07096c9a`** para N4/F-833. A leitura do objeto Git confirmou o guard de relatório repetido e a captura de tail por callback Main, saneada; relatório maior mantém o caminho anterior. Root informou **4 regressões RED antes → 291 PASS em 11 suítes**, tipos/sinks/lint PASS. A cauda `nexus.terminal-tail` é limitada a8192 caracteres pelo saneador, persistida antes de fechar e acompanhada de aviso de relatório incompleto; sem cauda útil conserva pane armado e ledger vazio. Esses testes foram executados pelo integrador, não por esta auditoria. A revisão independente N4 está em andamento por outro agente. Portanto o gap1 tem correção posterior implementada e verificada pelo autor, mas ainda precisa da revisão e do gate da união final; a matriz congelada não foi reescrita como se c385 já a contivesse.

`full-private-6e968c1e-receipt.json` foi lido nesta atualização: sourceSha `6e968c1e`, Node22.23.2, sessão48052, observedExitCode0, sete etapas incluindo tsc app/server. F-802/F-815 documentais e F-875 continuam sendo avanços externos/posteriores até seus commits serem recebidos e registrados.

## 9. Avanços posteriores conferidos pelo integrador (04/10 04:42 BRT)

Esta seção preserva a auditoria congelada c38533bd acima; não transforma
aquela árvore antiga no SHA atual nem constitui aceite do binário final.

- N4/F-833: 01c9ab8d e 32568689 completam procedência/replay físico e saneamento. Revisão independente `review-n4-followup.md` aprovou o delta exato325, incluindo Main/dispatcher/audit/receipt/SQLite reais; não muda artifacts completos ou a cadeia HMAC original. Gap1 tem código e revisão; permanece a validação do conjunto final.
- F-802/F-815: registros QA individuais recuperados em e6bcb4d1/8cbae3b0, com fonte/proveniência, sem inventar novos defeitos. Gap3 documental resolvido.
- C6/F-875: cbc6d00e/a65177f7/c039ab47/10064a7c integram coorte A/B, warmup Main, owner-death, launcher específico compatível com sandbox interno e proxy HTTP loopback herdado, sem enfraquecer o bootstrap geral. d8305e53 integra o transporte Bash posicional/FD3 do Grok. `native-d830-root-gates.log` e processo79821, exit0 observado: build universal ad hoc; 156 testes/11 suítes; tipos app; sinks0; ratchet91. Casos reais Claude2.1.289 e Grok1.0.46 usam perfis privados/gateway loopback fictício. Isso não prova outros adapters nem o candidato assinado.
- Revisão ampla680bea43: F883(566daeda), F884(5791/456286ed/014df539/1fb6166d), F885(061d9157), F886(09b5bbc9/7152ead3), F887(97c95bc3), F888(70eff762), F889(2dcfd610) e F890(bb968c49) têm correções e regressões reais. F890 tem aprovação independente exata; pareceres compostos restantes ainda em fechamento. Não reclassificar o parecer REJECT antigo como APPROVE por presença de commits.
- Licenças: 8711f6dc restaura licença/TPN ONNX1.19.2 oficiais com hashes; 6a117683 preserva licença Electron43.7.4 e Chromium extraídas do staging real, com gate de bytes/hashes e sem fallback. ae47e571 limita fixtures dependentes de Darwin. Gate privado119/4 e tipos/sinks/ratchet aprovado; licença no aplicativo assinado ainda pendente.
- Versão192: a369f136 prepara metadados, sem tag/publicação. Fetch remoto em04/10 04:37 confirma origin/main34d085fb; tag192 ausente na canônica e no espelho. Essa observação não autoriza inferir que seguirá livre na publicação.

Suíte21545 de6e permanece histórica. Carga final/regex/profile, matriz de CLIs,
revisão composta, suíte privada final, recursos5min, assinatura/notarização,
smokes reais e publicação permanecem sem aceite até seus receipts específicos.

Complemento04:48: 0aa33164 Kimi/proxy validado pelo Root em
`kimi-0aa-root-gates.log`, processo92672 terminal0 observado:26 testes/2
suítes, tipos app, sinks0 e Sync91. A normalização do proxy é limitada ao
localhost previamente validado. OpenCode default/bin/sh permanece sem
fechamento C6; não é considerado PASS por esse controle Kimi.

Revisão independente posterior: `review-final-root-native-deltas.md` aprova
os deltas examinados de F883–F888/F890 e Native inner/proxy/Bash/FD3 em
d830+0aa, com source/callers e probes reais e exclusões explícitas. N4 usa
parecer independente325; MiMo usa parecer de outro owner. F889 continua
sem autoaprovação do autor. O relatório não certifica OpenCode pendente,
plataformas reais não executadas, o harness novo ou o candidato assinado.

Soak source integrado em55691a0d (autor86822f23,22paths). Root leu fontes
e executou13 suítes/172 testes no private556 com Electron43.7.4; processo72512
exit0 observado, tipos/sinks0/Sync91. Primeira rodada em sharedElectron43.0.0
falhou somente2fixtures de licença; versão/bytes/hashes foram conferidos,
sem relaxar gate ou alterar dependências originais. Relatório independente
`review-soak-harness.md` aprova o source868/556 no escopo examinado, com
caller/preflight IO/crash/deadline, dormância da UI e Git/tag reais. Isso
fecha implementação/revisão do harness; os300s e métricas no app assinado
continuam pendentes de execução.

F889 recebeu parecer independente `review-f889-independent.md`: frozen10064
com owner2dc, cinco módulos idênticos a556, reprodução original preservada
SQLite/registry/runtime, child físico atéclose e drain antes do registry;
224PASS/7 suítes. Fecha a causa em fonte/unitários, sem ABI/signed/runtime
claim. A revisão dos novos transportes Native e a certificação final ficam
separadas. Levantamento do checklist confirmou lacunas no smoke existente
para início/stop de missões/workers/handoff/recovery e voz real; não
considerar prepare/list ou microfone negado como prova desses requisitos.

Preservação revalidada em ad1139bb: `preservation-current.json`,17/17
heads originais mantidos e ancestrais da integração;5/5 patches originais
e cópias salvas com SHA256 idêntico;3/3 arquivos untracked de memória
byteidênticos às cópias;6/6 provas originais do incidente byteidênticas
(stack1141/1146,memory,trace,hangmarker,pssnapshot). Não houve reset,
install/rebuild ou alteração dessas origens. Não imprimir o conteúdo
PS/trace bruto em respostas; recibo guarda apenas nomes/bytes/hashes.

Native Unix/F891 integrado emf999f33450a56f4566d96462a6af94292fed1534
(autor6a119a3ce), junto à reserva Main4fdd9965. O merge preservou
prepare-command e claim cancel/confirm. GateRoot privado
`native-f999-private-gates.log`, processo41073 terminal0 observado:
311PASS/15 suítes,8 skips existentes; tipos app, sinks0 e Sync91 aprovados,
Node22/npm12. Inclui CLI reais Claude/Grok/Kimi/OpenCode, supervisor/bridge/
manager, reservas/Main/failover/ACP. b3dd8637 integra somente matriz
C6ADAPTER1056551 com limites measured/shared/unknown. Não converter
8skips, transporte herdado ou strings em bundle em PASS de plataforma/CLI
real. Revisão independente do conjunto e outros boundaries permanecem
antes do freeze; nenhum binário assinado/publicação provado.

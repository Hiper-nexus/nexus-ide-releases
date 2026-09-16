# Inventário para religação da liderança única de missão

Data da leitura: 2026-09-16. Repositório: `nexus-ide`.

Leitura somente do código. O arquivo `src/main/orch/mission-leadership.ts` ainda
não estava visível no momento desta varredura; o inventário assume exatamente o
contrato informado:

```ts
resolveMissionLeader(scope, missionId) →
  { sessionId, paneId, source: 'durable' | 'live', proven: boolean } | null
assertSingleLeader(scope, missionId)
applyLeadership(scope, missionId,
  { sessionId, paneId, origin: 'spawn' | 'adopt' | 'respawn' | 'promote' })
```

Critério usado: `resolveMissionLeader` substitui qualquer decisão de leitura
sobre “quem é o líder”; `applyLeadership` substitui qualquer escrita de vínculo
de liderança. Papel genérico (`ctx.role`) continua sendo capacidade do token,
não identidade da liderança, salvo quando combinado hoje com o vínculo da
missão. Fixtures e testes não aparecem nas tabelas principais; não são alvo de
religação nesta rodada.

## Mapa por sítio

### Fonte A — `mission.orchestratorSessionId`

| file:line | fonte (A-F) | lê ou escreve | quem chama | classificação | risco da troca |
|---|---|---|---|---|---|
| `src/main/orch/mission-store.ts:86,295,637,660,2022` | A | lê/escreve projeção durável, schema, INSERT e hidratação | bootstrap de stores, CRUD, recovery | **MANTÉM** — é persistência e validação; deve continuar sendo storage interno do módulo, não resposta pública de liderança | baixo — trocar a projeção nesta rodada quebraria migração, CAS e compatibilidade do banco |
| `src/main/orch/mission-store.ts:720-738` | A | escreve `orch_session_id` sem CAS | bootstrap/respawn atual | **SUBSTITUI-POR-applyLeadership** — chamada direta não pode continuar fora do dono único | alto — uma escrita concorrente pode apagar ou ultrapassar outra encarnação |
| `src/main/orch/mission-store.ts:744-761` | A | escreve `NULL` apenas se a sessão esperada casar | teardown/recovery tardio | **MANTÉM** — é primitive de clear por CAS, mas o contrato informado não tem operação de release/clear | alto — removê-la sem API equivalente deixa demotion incapaz de revogar autoridade |
| `src/main/orch/mission-store.ts:770-877` | A | aposenta sessão anterior e pode rearmar missão numa transação | respawn/recovery pré-dispatch | **MANTÉM** — transação especializada de prova física, não é simples troca de líder | alto — aplicar `applyLeadership` antes da prova permitiria dois Maestros |
| `src/main/orch/mission-store.ts:885-952` | A | rebind durável e re-enfileiramento de handoffs | adoção, promote, recovery renderer | **SUBSTITUI-POR-applyLeadership** no chamador; conservar como primitive transacional interna até `applyLeadership` encapsulá-la | alto — rebind também altera transporte de handoff; ordem errada perde entrega ou cria split-brain |
| `src/main/orch/mission-fast-lane.ts:1062-1069` | A | escreve sessão após `spawnAgentPane` | bootstrap e respawn | **SUBSTITUI-POR-applyLeadership** com `origin:'spawn'` no bootstrap e `origin:'respawn'` no respawn; o registro só ocorre depois da prova do spawn | alto — falha entre pane criado e vínculo durável deixa runtime sem líder ou permite segundo spawn |
| `src/main/orch/mission-fast-lane.ts:2175-2181` | A | lê para provar adoção | adoção | **SUBSTITUI-POR-resolveMissionLeader** e exige `sessionId/paneId` do resultado; não comparar somente string durável | alto — hoje `grantAuthority=true` seguido de leitura antiga pode parecer adoção válida |
| `src/main/orch/renderer-mission-authority.ts:672-713` | A | lê e chama rebind | recovery via IPC / remount | **SUBSTITUI-POR-resolveMissionLeader** para validar candidato; **SUBSTITUI-POR-applyLeadership** para o rebind de recovery | alto — é fronteira main-owned; pane, sessão, gate e store precisam ser uma operação ordenada |
| `src/main/orch/renderer-mission-authority.ts:773-807` | A | escreve rebind e promove sessão anterior/nova | promote UI / adoção | **SUBSTITUI-POR-applyLeadership** com `origin:'promote'`; manter apenas sincronização derivada de contexto | alto — hoje atualiza `missionPanes`, missão, contexto e PTY em etapas separadas |
| `src/main/orch/handoff-delivery-runtime-recovery.ts:32-40,76-80` | A | lê sessão atual e escreve rebind | recovery de entrega | **SUBSTITUI-POR-resolveMissionLeader** para a pré-condição e **SUBSTITUI-POR-applyLeadership** para a substituição | alto — redelivery depende da sessão correta; uma troca parcial duplica ou perde handoff |
| `src/main/orch/mission-runtime-termination.ts:231-257,686-695` | A | lê para achar alvos e limpa sessão após término | recovery/teardown/demotion | **MANTÉM** nesta rodada — `applyLeadership` não representa clear; criar liderança durante teardown seria semanticamente errado | alto — é o caminho que revoga autoridade; religar por aproximação pode matar sessão nova ou deixar líder revogado |
| `src/main/orch/gate.ts:484-500` | A | lê e compara `ctx.sessionId` | gate de MCP e workflow | **SUBSTITUI-POR-resolveMissionLeader**; `assertOrchestratorMission` permanece como checagem de papel/missão | médio — centralizar melhora stale-token, mas `proven` precisa ser interpretado sem abrir caminho legacy indevido |
| `src/main/orch/mcp-server.ts:1279-1301` | A+D | lê sessão do contexto e missão para fallback v1 | stream legacy / recovery de transporte | **SUBSTITUI-POR-resolveMissionLeader**; conservar o filtro de contrato aprovado | alto — autoriza entrega física; aceitar apenas `ctx.role` ou uma sessão durável velha reabre o canal errado |
| `src/main/orch/idle-delivery.ts:177-207,437-459,1139-1167` | A+E | lê líder durável e confere runtime/pane | delivery idle, recovery de handoff, reconciler | **SUBSTITUI-POR-resolveMissionLeader**; runtime/pane passam a confirmar o resultado, não a escolher outro líder | alto — é o transporte de handoffs; apontar para A sem pane vivo já é hoje uma causa de wedge |
| `src/main/orch/mission-intent-gate.ts:202-213,267-280` | A+D | lê sessão para permitir `done` e usa papel para ack | gate de status e handoff | **SUBSTITUI-POR-resolveMissionLeader** na comparação de sessão; **MANTÉM** papel como capacidade adicional | alto — são gates de mutação; uma autorização permissiva vira alteração de missão por sessão stale |
| `src/main/orch/clarify-flow.ts:183-189,350-370` | A+D | lê/compara sessão da pergunta e do contexto | MCP clarify / UI de resposta | **SUBSTITUI-POR-resolveMissionLeader** para identidade atual; histórico da pergunta permanece histórico | alto — pergunta e resposta podem ficar associadas a encarnações diferentes |
| `src/main/orch/mission-open-question.ts:94-130` e `src/renderer/orch/mission-pending-question.ts:68-80` | A+F | lê sessão para selecionar pergunta corrente | rail/UI e recovery pós-respawn | **SUBSTITUI-POR-resolveMissionLeader** como filtro corrente; handoff antigo continua fallback histórico | médio — afeta UX e CTA, mas não deveria mutar autoridade |
| `src/main/orch/operator-review-feedback.ts:115-165` | A | lê sessão para gerar fence | recovery/UI de revisão do operador | **SUBSTITUI-POR-resolveMissionLeader** | médio — fence incorreto entrega revisão ao processo errado; efeito é limitado ao fluxo de revisão |
| `src/main/orch/pet-studio-completion.ts:618-632` | A | lê e compara origem do handoff | recovery de conclusão Pet Studio | **SUBSTITUI-POR-resolveMissionLeader** | médio — pode completar pacote errado ou recusar o válido; não é escritor de liderança |
| `src/main/orch/mission-engine-production.ts:199-243,632-703,807-835,897-915` | A+C+E | usa sessão como autoridade direta, runtime e kickoff | direct dispatch / bootstrap de missão | **MANTÉM** nesta rodada — o caminho também modela o modo livre “operador é orquestrador”, worker fallback e recibos; exige API/semântica adicional antes de trocar | alto — substituir `undefined` por `null` ou qualquer líder durável mudaria o fail-closed e o caminho sem orquestrador |
| `src/main/orch/mission-engine-production.ts:1025-1100,1132-1137` | A+C+E | monta snapshot escolhendo uma pane por role e sessão por A | reconciler/observabilidade do motor | **SUBSTITUI-POR-resolveMissionLeader** e torna a pane/sessão derivação do mesmo resultado | médio — é projeção, mas hoje pode fabricar associação pane↔sessão inexistente |
| `src/main/orch/mission-independent-review-gate.ts:185-220,278-304` | A | recebe sessão corrente para avaliar recibos | completion/recovery/reconciler | **SUBSTITUI-POR-resolveMissionLeader** no parâmetro de corrente; manter attempts históricos como prova | médio — falso negativo bloqueia conclusão; falso positivo depende de proof ledger main-owned |
| `src/main/orch/civilian-delivery-completion.ts:858-860,1310-1320` | A+C+E | lê sessão na decisão e no fingerprint de reconciliação | reconciler de conclusão | **SUBSTITUI-POR-resolveMissionLeader** para o campo corrente; o fingerprint pode manter histórico completo | médio — inconsistência altera idempotência e pode repetir a conclusão |
| `src/main/orch/civilian-pronto.ts:527-529` | A | lê sessão para handoffs pendentes | reconciler/UI de prontidão | **SUBSTITUI-POR-resolveMissionLeader** | médio — pode exibir pronto ou não-pronto incorretamente, sem escrever liderança |
| `src/main/orch/tools-handoff.ts:539-545,730-750` | A+D | lê destinatário e grava ack com `ctx.sessionId` | worker submit, lista e ack MCP | **SUBSTITUI-POR-resolveMissionLeader** para destinatário/validação; payload histórico continua com sessão que aceitou | alto — ack com sessão stale altera estado de entrega |
| `src/main/orch/tools-domain.ts:361-377,525-550` | A | lê sessão para push e prova de review | `mission_set_status` / completion MCP | **SUBSTITUI-POR-resolveMissionLeader** | alto — push e conclusão são efeitos externos; devem usar líder provado, não apenas row atual |
| `src/renderer/orch/mission-list-action.ts:19-20,61-63` | A+F | lê presença/ausência da sessão para CTA | UI | **SUBSTITUI-POR-resolveMissionLeader** apenas para saber se há liderança; status lifecycle continua vindo da missão | médio — CTA errado pode fechar/remover ou esconder Retomar |

### Fonte B — `orchPanes` em `mission-fast-lane.ts`

| file:line | fonte (A-F) | lê ou escreve | quem chama | classificação | risco da troca |
|---|---|---|---|---|---|
| `src/main/orch/mission-fast-lane.ts:1246` | B | cria mapa process-local | bootstrap/reconciler fast-lane | **VIRA-DERIVADO** — o mapa não pode decidir o líder; no máximo cache da projeção retornada por `resolveMissionLeader` | médio — cache sobreviverá menos que o processo e hoje não carrega `scope` na chave |
| `src/main/orch/mission-fast-lane.ts:1870-1878` | B | escreve pane/sessão após respawn | respawn | **SUBSTITUI-POR-applyLeadership** com `origin:'respawn'`; se o mapa persistir, recebe o resultado | alto — escrever B antes de A/C confirma pode deixar pane fantasma como líder |
| `src/main/orch/mission-fast-lane.ts:1930-1931` | B | lê sessão para teardown | unfocus/teardown | **VIRA-DERIVADO** — usar resolver + inventário físico para alvos; B sozinho não é autoridade | alto — mapa pode estar stale ou apontar sessão de outro workspace |
| `src/main/orch/mission-fast-lane.ts:1946-1949` | B | apaga entrada | unfocus/release | **MANTÉM** — limpeza de cache, não clear de liderança; só depois de terminar runtime | baixo — remover cedo perde referência de teardown, mas não deve escrever A |
| `src/main/orch/mission-fast-lane.ts:2390-2398` | B | escreve entrada após adoção | bootstrap/adoção | **VIRA-DERIVADO** de `applyLeadership(origin:'adopt')` | médio — se entrar antes da confirmação, UI e watcher podem usar pane que não recebeu autoridade |
| `src/main/orch/mission-fast-lane.ts:2467-2474` | B | escreve entrada após spawn | bootstrap | **VIRA-DERIVADO** de `applyLeadership(origin:'spawn')` | alto — este é o segundo escritor paralelo do caminho normal |
| `src/main/orch/mission-fast-lane.ts:2879-2903` | B+C+E | lê B e cai para snapshot live por role | UI summary / rail | **SUBSTITUI-POR-resolveMissionLeader**; metadados de título/adapter podem ser enriquecimento | médio — summary stale pode apontar o pane errado sem necessariamente mutar estado |
| `src/main/orch/mission-fast-lane.ts:478-494,2277-2283,2775-2787` | E+B | usa função live local e B indiretamente | bootstrap/resume/remount | **SUBSTITUI-POR-resolveMissionLeader**; `source`/`proven` devem dirigir watch vs respawn | alto — esta é a decisão operacional que hoje diverge da cerca do PTY |

### Fonte C — `missionPanes` com `role:'orchestrator'`

| file:line | fonte (A-F) | lê ou escreve | quem chama | classificação | risco da troca |
|---|---|---|---|---|---|
| `src/main/orch/mission-pane-store.ts:395-458` | C | escreve role do alvo e rebaixa role anterior | promote/adoção | **SUBSTITUI-POR-applyLeadership** no chamador; conservar a transação como storage interno até o módulo assumir ambas as projeções | alto — esta operação hoje pode concluir C antes de A |
| `src/main/orch/mission-pane-store.ts:486-525` | C | lê role para reseal de autoridade | recovery/reconciler de selo | **MANTÉM** — reseal é autoridade de workflow, não eleição de líder; apenas deve receber o pane resolvido | médio — trocar por resolver sem separar selo de liderança confundirá revisão com eleição |
| `src/main/orch/mission-fast-lane.ts:235-251` | C | registra pane com role recebido do spawn | bootstrap/first-wave | **VIRA-DERIVADO** — role da pane de missão nasce da decisão do módulo; worker continua role normal | alto — um role mal registrado afeta gates, teardown e reopen |
| `src/main/orch/tools-domain.ts:259-287` | A+C+D | cria missão, grava A e registra C, promove `ctx` | MCP `nexus_mission_create` | **SUBSTITUI-POR-applyLeadership**, mas há incompatibilidade: o contrato não tem `origin:'create'` | alto — não religar cegamente; decidir antes se criação é `spawn`, `adopt` ou nova origem |
| `src/main/orch/tools-panes.ts:615-631,760-778` | C+D | lê role para gate/spawn e contagem de workers | delegação MCP | **SUBSTITUI-POR-resolveMissionLeader** no gate do chamador; filtros de worker permanecem derivados | alto — um worker stale pode abrir orquestrador ou o orquestrador errado pode delegar |
| `src/main/orch/mission-engine-production.ts:1027-1031,1135-1137` | C+A | escolhe primeiro pane com role e associa A | snapshot/reconciler do motor | **SUBSTITUI-POR-resolveMissionLeader** | médio — múltiplas rows C hoje tornam “first match” não determinístico |
| `src/main/orch/civilian-delivery-completion.ts:862-867,1214-1218` | C | lê panes com role para busy/nomes | reconciler/completion | **VIRA-DERIVADO** — filtrar a pane devolvida por resolver; workers continuam classificação de composição | médio — uma pane duplicada pode atrasar/adiantar conclusão |
| `src/main/orch/civilian-pronto.ts:270-280,494-501` | C | lê role para resumo e busy | reconciler/UI | **VIRA-DERIVADO** | baixo — é observacional, desde que não escolha outro líder |
| `src/main/orch/delegation-supervisor.ts:475-498` | A+C | considera A ou qualquer C e usa state de C | reconciler/recovery | **SUBSTITUI-POR-resolveMissionLeader**; estado físico vem do pane retornado | alto — o `OR` explícito mascara divergência e pode rearmar handoff por uma pane errada |
| `src/main/orch/handoff-delivery-runtime-recovery.ts:52-73` | C+E | escolhe pane C pelo `paneId` pedido | recovery | **SUBSTITUI-POR-resolveMissionLeader** e compara o pane resolvido antes de pedir recovery | alto — recovery em pane que não é líder pode rebindar a sessão errada |
| `src/main/orch/pane-registry.ts:1142-1160` | C+E | valida row C contra runtime físico | bootstrap/reconciler | **VIRA-DERIVADO** — validação física permanece, mas role esperado vem da liderança resolvida | alto — é a fronteira que impede apresentar autoridade stale ao renderer |

### Fonte D — `ctx.role === 'orchestrator'` e equivalentes MCP/gate

| file:line | fonte (A-F) | lê ou escreve | quem chama | classificação | risco da troca |
|---|---|---|---|---|---|
| `src/main/orch/gate.ts:463-472` | D | lê role e missionId | todos os gates de missão | **MANTÉM** — autoriza classe de token e escopo; não identifica sessão líder sozinho | baixo — retirar esse gate abriria capability indevida |
| `src/main/orch/gate.ts:608-645` | D | escreve role/capabilities do contexto promovido | promote/adoção | **VIRA-DERIVADO** de `applyLeadership`; manter mutação como sincronização de capability, depois da confirmação | alto — hoje o contexto novo pode ficar promovido enquanto A/C falham |
| `src/main/orch/mcp-dispatch.ts:381-392` | D | testa role para delegation authority | despacho MCP | **SUBSTITUI-POR-resolveMissionLeader** além do teste de capability | alto — role stale basta hoje para passar esta etapa |
| `src/main/orch/mcp-server.ts:1283-1298` | D+A | testa role/sessão e contrato | stream legacy | **SUBSTITUI-POR-resolveMissionLeader** | alto — canal físico e fallback de handoff são efeitos de segurança |
| `src/main/orch/mission-intent-gate.ts:205-213,269-276` | D+A | role para done/ack | gate de status/handoff | **SUBSTITUI-POR-resolveMissionLeader** na identidade; MANTÉM role como capability | alto — stale context pode marcar done ou aceitar ack |
| `src/main/orch/tools-handoff.ts:662-665,695-704,734-750` | D+A | role decide cross-mission list e ack | lista/ack MCP | **SUBSTITUI-POR-resolveMissionLeader** para a própria missão; cross-mission auditado continua política separada | alto — leitura cross-mission e mutação de handoff têm superfícies diferentes |
| `src/main/orch/tools-panes.ts:615-617` e `src/main/orch/tools-domain.ts:1386-1398` | D+A | role escolhe autoridade e depois, em um caminho, valida sessão | spawn/route_task | **SUBSTITUI-POR-resolveMissionLeader** na validação de missão; manter operador como classe distinta | alto — sem a troca, um contexto stale ainda inicia delegação |
| `src/main/orch/tools-context.ts:625-638` | D | exige role para sensor e revalida invocation | MCP sensor/reconciler | **SUBSTITUI-POR-resolveMissionLeader** antes do sensor; assertion de invocation permanece | médio — sensor é efeito controlado, mas pode gravar evidência no líder errado |
| `src/main/orch/pane-authz.ts:150-160` e `src/main/orch/pane-close-scopes.ts:33-45` | D+C | role impede worker de escrever/fechar líder | pane tools/teardown | **VIRA-DERIVADO** — role do pane deve refletir resolver; política worker-vs-orchestrator permanece | médio — trocar a política por resolver diretamente faria perder distinção de ação |

### Fonte E — `liveOrchestratorSessionId`, sessões registradas e runtime físico

| file:line | fonte (A-F) | lê ou escreve | quem chama | classificação | risco da troca |
|---|---|---|---|---|---|
| `src/main/pty/pty-manager.ts:1214-1234` | E+D | cerca spawn por qualquer sessão registrada do mesmo mission/família | spawn físico | **MANTÉM** — é fence de processo, deliberadamente mais conservador que liveness | alto — substituir pela resposta live e ignorar `exited/unverifiable` cria dois processos |
| `src/main/pty/pty-manager.ts:1245-1269` | E | lê inventário de sessões registradas | respawn fast-lane | **VIRA-DERIVADO** — resolver deve consultar este inventário; a lista segue necessária para prova/terminate | alto — não confundir “registrada” com “líder vivo” |
| `src/main/pty/session-liveness.ts:1-72` | E | classifica live/exited/unverifiable | fast-lane e fence | **MANTÉM** — é o contrato de liveness física, não a eleição de liderança | alto — mudar a taxonomia junto da religação altera a política de respawn |
| `src/main/orch/mission-fast-lane.ts:478-494` | E+C | deriva sessão live de snapshot role/name e estado | bootstrap/resume/remount | **SUBSTITUI-POR-resolveMissionLeader**; resolver deve devolver `source` e `proven`, e esta função deve desaparecer | alto — role por nome “orquestrador” é fallback não-canônico |
| `src/main/orch/mission-fast-lane.ts:1841-1863` | E | lista sessões registradas e termina antes de respawn | respawn | **MANTÉM** como fence/limpeza física; antes do spawn deve haver `applyLeadership(origin:'respawn')` somente após prova | alto — ordem de terminate e apply é a barreira anti-split-brain |
| `src/main/orch/civilian-delivery-completion.ts:1069-1081,1123-1131` | E+C | deriva live por pane role e estado busy/idle | completion/review repair | **SUBSTITUI-POR-resolveMissionLeader** | médio — reparo automático pode ser enviado ao pane errado |
| `src/main/orch/civilian-auto-review.ts:68,331-340` | E | recebe sessão live e injeta repair prompt | reconciler de revisão automática | **SUBSTITUI-POR-resolveMissionLeader** na montagem do input | médio — prompt de reparo no runtime errado é efeito reversível, mas pode consumir orçamento |
| `src/main/orch/idle-delivery.ts:1148-1164,1207-1214` | E+C+A | confirma runtime/pane e drena mailbox | reconciler de delivery | **VIRA-DERIVADO** da liderança resolvida; os checks físicos continuam | alto — mailbox é estado de transporte e não tolera sessão substituta silenciosa |
| `src/main/orch/main-owned-agent-spawn.ts:356-368` | E+C | re-seal de pane persistida cujo role é orchestrator | boot/reconciler de panes | **VIRA-DERIVADO** — re-selo não é promote | médio — misturar re-selo com eleição pode trocar autoridade sem spawn/adopt |

### Fonte F — renderer `pane.role` e `paneMissions`

| file:line | fonte (A-F) | lê ou escreve | quem chama | classificação | risco da troca |
|---|---|---|---|---|---|
| `src/renderer/state/orch-store.ts:28,241,247-262` | F | escreve/limpa `paneId → missionId` | hydrate, remount, layout | **VIRA-DERIVADO** — mirror local, nunca fonte de liderança | médio — binding stale esconde missão ou direciona UI para outra |
| `src/renderer/state/layout-store.ts:834-841` | F | lê `paneMissions` para impedir herança em split | UI split | **VIRA-DERIVADO** | baixo — é regra de layout, não autoridade |
| `src/renderer/state/layout-store.ts:1336-1357` | F | escreve role de panes em promoção | promote UI | **VIRA-DERIVADO** após confirmação main; não deve eleger | alto — UI pode mostrar dois líderes antes do IPC terminar |
| `src/renderer/state/layout-store.ts:1359-1370` | F | força um role e rebaixa os demais | UI genérica | **MANTÉM** para invariantes visuais, mas deve ser proibido de representar promoção de missão sem main | alto — é um segundo escritor local de “orchestrator” |
| `src/renderer/orch/orch-bridge.ts:125-146` | F+C+E | aposenta panes locais stale por role/mission e sincroniza | recovery/remount UI | **SUBSTITUI-POR-resolveMissionLeader** para escolher `keepPaneId`; close de cadáver continua derivado | alto — fechar um pane local errado pode apagar transcript antes da confirmação main |
| `src/renderer/orch/orch-bridge.ts:535-555` | F+A+E | faz bind local, envia recovery e chama rebind | recovery UI | **SUBSTITUI-POR-resolveMissionLeader** + **SUBSTITUI-POR-applyLeadership** no IPC main | alto — hoje bind local ocorre antes do rebind durável |
| `src/renderer/orch/orch-bridge.ts:778-789` | F+A | liga pane ao mission pelo `mission.orchestratorSessionId` | hydrate/UI | **SUBSTITUI-POR-resolveMissionLeader** | médio — late IPC pode usar row antiga e vincular pane errado |
| `src/renderer/orch/mission-reopen.ts:291-323` | F+C+E | liga panes, escolhe índice role orchestrator e pede rebind | reopen/recovery UI | **SUBSTITUI-POR-resolveMissionLeader**; `applyLeadership(origin:'respawn')` deve ser main-owned após sessão confirmada | alto — escolher “primeiro role” é ambíguo quando C tem duplicata |
| `src/renderer/orch/mission-pane-presentation.ts:39-57,74-99` | F+C | materializa pane visual com role orchestrator e binding local | bootstrap/reopen UI | **VIRA-DERIVADO** da sealed authority retornada pelo main | médio — apresentação pode anteceder attach físico, por isso não confirma liderança |
| `src/renderer/orch/adopted-orchestrator-reflect.ts:58-69` | F+C | lê C, promove role local e faz binding | adoção UI | **VIRA-DERIVADO**; confirmação deve vir de `resolveMissionLeader`/IPC | alto — hoje role C confirmado localmente pode chegar antes de A |
| `src/renderer/orch/mission-pane-presentation.ts:80-82` e `src/renderer/orch/close-mission-runtime.ts:40` | F | lê fallback `paneMissions` para identificar missão | apresentação/close UI | **VIRA-DERIVADO** | baixo — somente classificação de pane, desde que não seja usada para eleger |
| `src/renderer/orch/account-restart-controller.ts:50-57` | F | filtra panes ligados à missão e exclui orchestrator | restart UI | **VIRA-DERIVADO** | baixo — erro afeta seleção de panes, não grava liderança |
| `src/renderer/orch/failover-controller.ts:103` e `src/renderer/orch/failover-decision.ts:30-47` | F | usa binding local para decidir continuidade | recovery/failover UI | **SUBSTITUI-POR-resolveMissionLeader** para missionId/pane líder; manter decisão same-account separada | médio — failover pode operar sobre missão identificada por binding velho |
| `src/renderer/orch/mission-auth-conflict.ts:24-30` e `src/renderer/orch/restore-agents-gate.ts:50-55` | F | encontra pane live/agent por role | restore/auth UI | **VIRA-DERIVADO** | médio — UI pode bloquear restore por cadáver ou tratar worker como líder |
| `src/renderer/orch/stranded-mission-handoff.ts:66-137,150` | F | escolhe pane orchestrator entre panes stranded e `paneMissions` | recovery UI | **SUBSTITUI-POR-resolveMissionLeader** para seleção; fallback visual só como diagnóstico | alto — pode entregar a recuperação ao pane errado |
| `src/renderer/orch/mission-last-pane-notify.ts:50-77` | F | deriva missionId do pane ao fechar/notificar | UI close/reconciler | **VIRA-DERIVADO** | baixo — notificação não deve decidir liderança |

## Ordem de religação recomendada

1. **Base de leitura sem efeito:** `mission-fast-lane.ts:2879-2903`, summaries de
   `civilian-pronto.ts`, `civilian-delivery-completion.ts` e snapshots do motor.
   Trocar primeiro os leitores que só projetam estado; comparar `sessionId` e
   `paneId` do resultado, sem usar `source:'live'` como sinônimo de `proven`.

2. **Mirror renderer/UI:** `orch-store`, `layout-store`, `orch-bridge` de
   hydrate, `mission-pane-presentation`, `mission-last-pane-notify` e os
   filtros de failover/restore. O renderer deve refletir o líder confirmado pelo
   Main; `paneMissions` fica apenas como índice local de layout.

3. **Gates de leitura/autorização:** `gate.ts`, `mission-intent-gate.ts`,
   `mcp-dispatch.ts`, `mcp-server.ts`, `tools-panes.ts`, `tools-domain.ts`,
   `tools-handoff.ts`, `clarify-flow.ts`, `idle-delivery.ts` e os gates de
   review. Centralizar a checagem exata em um helper que chama
   `resolveMissionLeader`; manter o teste de papel como capability adicional.

4. **Bootstrap/spawn:** `mission-fast-lane.ts:1062`, o registro de pane em
   `bindSpawnedMissionPane` e os pontos `orchPanes.set`. A sequência segura é:
   spawn físico confirmado → `applyLeadership(origin:'spawn')` → registrar/cachear
   projeção → iniciar watcher/first wave.

5. **Respawn:** `respawnFastLaneOrchestrator` e failover main-owned. Só depois
   de terminar sessões antigas com prova física e confirmar o novo pane aplicar
   `origin:'respawn'`; a cerca de `pty-manager.ts:1214-1234` continua mais
   conservadora que a decisão de “live”.

6. **Adoção:** `adoptOrchestratorPane` e
   `renderer-mission-authority.ts:750-844`. Aplicar `origin:'adopt'` uma vez,
   depois sincronizar role/capabilities e renderer. Não usar `grantAuthority`
   nem `missionPanes.role` como prova independente.

7. **Promote/recovery:** promotion UI, `mission-pane-store.promote...`, recovery
   de pane e `mission-reopen`. São os mais perigosos porque alteram A, C, D, E e
   F em etapas; o módulo precisa tornar a decisão idempotente e a ordem de
   confirmação explícita antes de substituir os calls.

8. **Somente por último:** retirar chamadas externas a
   `setOrchestratorSession`/`rebindOrchestratorSession` e converter os caches.
   Não remover os primitives de storage até `applyLeadership` cobrir também a
   transação de handoff e existir uma operação explícita de clear.

## Três discordâncias possíveis hoje

### 1. A × E/B no resume da Via Rápida

1. A missão permanece `running` e A conserva `orchestratorSessionId = S_old`.
2. `S_old` fica `exited` ou não é encontrado no snapshot atual.
3. Um snapshot/runtime `S_new` da mesma missão aparece `busy`/`idle`, ou o
   `orchPanes` process-local ainda aponta para `S_new`.
4. `liveOrchestratorSessionId()` escolhe `S_new`; `fastLaneBootstrap()` decide
   `watch` e liga o watcher em `S_new`.
5. `gate.ts`, `idle-delivery.ts` e `mcp-server.ts` continuam validando A=`S_old`.
6. O watcher observa uma sessão, mas delivery/gates recusam a outra: missão
   running sem coordenação, ou retry que tenta respawnar sobre uma sessão que a
   cerca ainda considera registrada.

### 2. A × C durante promote/adoção

1. `renderer-mission-authority.ts:773` chama
   `missionPanes.promotePaneToOrchestrator(M, P_new)`, que grava C=`P_new` e
   rebaixa C=`P_old`.
2. Antes da linha 796 concluir, o mission row desaparece, o CAS falha, ou a
   sessão de `P_new` perde a condição de owned pane.
3. C já diz que `P_new` é orchestrator, enquanto A ainda é `S_old` ou `NULL`.
4. Um leitor como `mission-engine-production.ts:1030` ou
   `delegation-supervisor.ts:480` encontra `P_new`; um gate que lê A rejeita
   `P_new`, ou um leitor que usa `A || C` aceita a promoção incompleta.
5. Se o processo continua, o contexto D pode ser promovido em seguida, criando
   três respostas diferentes para a mesma missão.

### 3. A × D/F após rebind ou restart de renderer

1. A missão é rebindada para `S_new` após respawn/recovery, mas um contexto D de
   `S_old` continua registrado com `role:'orchestrator'` até sua limpeza tardia.
2. O renderer ainda conserva F=`paneMissions[P_old]=M` ou uma pane local com
   `role:'orchestrator'`.
3. `tools-handoff.ts`/`mcp-dispatch.ts` passam a primeira barreira pelo role D,
   enquanto `gate.ts`/`mcp-server.ts` que comparam A recusam `S_old`; a UI pode
   ainda exibir `P_old` como coordenador.
4. Em paralelo, `orch-bridge.ts:783-789` pode re-ligar um pane pelo A recebido
   em um broadcast atrasado, reforçando F errado.
5. Resultado: o usuário vê uma liderança, o token stale tem capacidade parcial,
   e a missão durável aponta para outra sessão. É exatamente o caso em que
   `resolveMissionLeader` precisa retornar `paneId` junto com `sessionId` e
   `proven`, e os demais mirrors devem deixar de escolher por conta própria.

## O que não deve ser religado nesta rodada

- **Schema, row mapping e CAS internos de `mission-store.ts`.** Eles são a base
  durável; a primeira rodada deve trocar callers, não reescrever SQLite.
- **`clearOrchestratorSessionIfMatches` e o clear em
  `settleMissionRuntimeDemotion`.** `applyLeadership` não tem `release`/`clear`.
  Sem essa API, trocar por `resolveMissionLeader` ou aplicar outro líder durante
  teardown pode ressuscitar autoridade revogada.
- **`retireOrchestratorSessionForReplacement` e a cerca de `pty-manager`.** A
  prova de saída física, inclusive para `exited`/`unverifiable`, é uma política
  anti-dois-processos e não uma simples resolução de líder.
- **Histórico e provas:** `handoff-store.ts`, `handoff-physical-ack-authority.ts`,
  `mission-kickoff-proof-ledger.ts` e campos `orchestratorSessionId` de attempts.
  Esses campos registram quem aceitou um evento; não devem ser reescritos para
  acompanhar o líder atual.
- **`goal-governor.ts:165,650,729`.** `goal.orchestratorSessionId` é dono de um
  goal, não necessariamente o líder da missão; misturar os dois domínios é uma
  mudança de contrato.
- **Caminho especial de `mission-engine-production.ts:644-703`.** O modo livre
  pode tratar o operador como orquestrador e cair em worker; a API nova não
  expressa esse estado explicitamente.
- **Checks puramente de capability/role e regras de workers.** Por exemplo,
  `gate.ts:463-472`, `pane-authz.ts:150-160` e políticas de acesso continuam
  necessários; apenas a parte de identidade atual deve consultar o resolver.
- **`orchestration-reconciler.ts` em si.** Ele só fornece cadence, single-flight
  e isolamento de erros; religue os participantes, não o relógio genérico.
- **Testes e fixtures.** Esta entrega é inventário; não alterar testes agora.
  Quando cada grupo for religado, atualizar o teste co-local e executar o teste
  focado, `npm run typecheck` e, para Main/renderer IPC,
  `npm run security:renderer-sinks`.

Conclusão operacional: a primeira troca segura é fazer todos os leitores
consumirem o par `(sessionId,paneId)` de `resolveMissionLeader`. Os quatro
escritores de eleição reais são bootstrap, adoção, respawn e promote; cada um
deve chamar `applyLeadership` exatamente uma vez. Criação direta de missão e
clear de teardown exigem extensão explícita do contrato antes de serem
religados.

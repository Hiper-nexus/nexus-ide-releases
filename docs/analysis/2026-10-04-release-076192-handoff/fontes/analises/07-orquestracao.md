# handoff-5b20152b-8e3e-45b2-a0b5-4a63934388a3 (Codex · gpt-6.1-sol)

# Auditoria da orquestração e saúde dos panes

1. Resumo executivo

Auditoria SOMENTE LEITURA do checkout /Users/cleofaspereirarocha/nexus-ide, HEAD 32230db894eadbb31dec06ee34e4dac50c517fb5 (0.76.190). Nenhum arquivo editado, nenhuma branch trocada, nenhum stash/reset/clean/push executado. As exclusões de recursos nativos vistas no git status inicial foram preservadas; o status final estava limpo por alteração externa à auditoria. Não registrei arquivos de QA porque o brief proíbe escrita.

Há recuperação de modelo rejeitado implementada, mas a mensagem real do Codex não entra nela. Corrigir somente o PATH também deixa lacunas: o watchdog pode considerar o primeiro turno iniciado antes da falha permanente; a rotação considera apenas migração/default; e o evento switched pode preceder o religamento real. A prevenção precisa vincular catálogo e executável, reconhecer o erro e reutilizar a recuperação existente com alternativas elegíveis e recibo posterior ao sucesso.

O F-234 confunde sincronização com integração e também perde integrações cujo destino não aparece nos argumentos. O gate de entrega já aceita operações/consultas sem arquivo; a criação MCP, porém, pode classificá-las como standard. Há ainda um caminho mecânico de handoff que nasce success sem a revisão Jev aplicada ao MCP.

Validação: 12 suítes focadas, 257 testes aprovados, mais reproduções de funções reais. Nenhuma correção foi aplicada. As métricas abaixo têm cobertura parcial: 99 tentativas MCP de spawn, 66 aceitas e 33 recusadas; isso não mede, sozinho, saúde de inferência. Não foi possível atribuir o “siga” nem reconstruir todos os modelos efetivamente executados nos 14 dias. Entrega partial por essas lacunas, sem pergunta pendente ao humano.

2. Fluxo real, com os elos e seus limites

• Prompt → hooks: src/main/orch/hook-status-config.ts:83 instala UserPromptSubmit/delegate no Claude; :156 combina status e delegate/regression/integration no Codex. src/main/orch/mcp-server.ts:2067 encaminha /hook/delegate a handleHookDelegateHttp.
• Dica do Jev: src/main/jev/jev-delegation.ts:97 exige prompt de pelo menos 40 caracteres, prazo de 2,5 s e divisibilidade ≥0,6 com pelo menos duas partes. src/main/orch/hook-delegate-endpoint.ts:328 e :480 transformam pedido do operador no Maestro em diretiva de abrir workers. Em :417, Autopilot com ≥0,7 e duas partes pode adotar o pane user pela missão da aba. Handoffs e mensagens de failover têm caminhos próprios.
• Intake é outro julgamento: src/main/orch/intent-router.ts:257 chama src/main/orch/intent-router-jev.ts:168 para escolher direct-answer, mission-question ou mission-work. Não é a classificação da rota do worker.
• Maestro → spawn/rota: src/main/orch/tools-panes.ts:1219 chama o resolver automaticamente quando faltam adapter/resume/reserva na missão. src/main/orch/tools-domain.ts:2096 registra routeTaskForCaller como resolver comum. Delegação não exige uma chamada prévia a nexus_route_task.
• Classificação → escolha: src/main/orch/tools-domain.ts:1681 chama classifyTaskWithSkillForRouting; src/main/orch/jev-task-routing.ts:218 aceita classificação com confiança ≥0,6, prazo de 5 s. Jev sugere tier/especialidade/esforço; src/main/orch/tools-domain.ts:1897 e src/main/orch/task-router.ts:1017 aplicam a política. src/main/orch/task-router.ts:1115 filtra quarentena de modelo.
• Reserva: src/main/orch/tools-domain.ts:2013 chama src/main/orch/mission-route-reservation-ledger.ts:273, selando missão running, revisão, squad, modelo, esforço e prazo. src/main/orch/tools-panes.ts:1575 valida a reserva; :1819 a consome.
• Capacidade/spawn: src/main/orch/tools-panes.ts:1690 conta workers vivos e reservas pendentes; :2005 instala watchdog e closures de reentrega/reroute. src/main/pty/pty-manager.ts:1668 exige o executável absoluto. src/main/path-resolver.ts:483 escolhe o primeiro executável encontrado no PATH.
• Worker → handoff MCP: src/main/orch/tools-handoff.ts:395 aplica regressão; :423 aplica revisão Jev; :592 persiste com receipt/transição; :630 entrega ao Maestro. src/main/orch/idle-delivery.ts:1311 implementa a entrega. Em tools-handoff.ts:578, F-239 distingue rodada nova e replay.
• Base da regressão: src/main/orch/handoff-regression-gate.ts:30 obtém a base do writer isolado, execução da missão ou spawn, sem confiar numa base declarada pelo worker. src/main/orch/regression-gate-handoff.ts:151 permite devoluções limitadas e depois registra blocked; :127/:138 tratam infraestrutura indisponível como skipped/não verificado.
• Revisão Jev: src/main/orch/jev-handoff-review.ts:131 julga relatório/metadados limitados, sem ler o payload completo dos artifacts nem inspecionar o produto físico. :389 permite uma devolução; :407 aceita a próxima entrega fraca com marca weak; :324 pode skipped sem credencial/julgador.
• NEXUS_HOOK_REGRESSION_URL: src/main/orch/mcp-server.ts:1129 entrega URLs ao spawn; hook-status-config.ts:115 instala Stop/regression. src/main/orch/hook-regression-endpoint.ts:92 exclui workers/helpers com pai operador desse Stop gate, pois passam no gate de entrega.
• Handoff mecânico: src/main/orch/turn-end-handoff.ts:307 monta payload; :333 define success; :552 chama submitPtyStreamHandoff. src/main/orch/pty-stream-handoff.ts:355 aplica regressão sem canal de retry e sem chamar reviewMissionHandoff.
• Integração F-234: src/main/orch/hook-integration-endpoint.ts:110, src/main/orch/tools-git.ts:505 e src/main/orch/tools-domain.ts:521 chamam assertIntegrationReviewed. src/main/orch/integration-review-gate.ts:96 exige árvore rastreada limpa e revisão frontier do HEAD exato. src/main/orch/tools-domain.ts:881 registra verdict com identidade/HEAD observados pelo Main.
• Conclusão: nexus_mission_set_status entra em src/main/orch/tools-domain.ts:600; :630 pode verificar missão standard com squad; :665 valida workflow/nota; :776 monta resultado e :792 chama completeVerified. src/main/orch/mission-engine-production.ts:1594 verifica pergunta/equipe/revisão/artefatos antes de gravar done; :1618 chama o gate de entrega física.

3. Achados por gravidade, causa e menor correção correta

P1 — Erro permanente Codex fica fora do detector existente.

Evidência de código: src/main/orch/limit-detector.ts:197–222 reconhece formatos canônicos, incluindo model "nome" is not supported e model_not_supported. A frase do caso não corresponde.

Reprodução somente leitura por tsx, importando detectLimit:

  Error: HTTP 400: model is not supported when using Codex with a ChatGPT account
  → null
  Error: The gpt-6.1-sol model is not supported when using Codex with a ChatGPT account
  → null
  Error: model "gpt-6.1-sol" is not supported
  → kind:model, cooldownMs:300000

Recuperação existente: src/main/orch/failover.ts:1740 recebe a janela PTY; :1456 quarentena o modelo, escolhe rotação e tenta religar na mesma conta. Não é necessário criar um segundo motor baseado em Jev.

Correção mínima: acrescentar o formato específico Codex/ChatGPT, com contexto de erro, ao detector. Evitar regex genérica de “not supported”. Teste novo em limit-detector.test.ts: erro real entra como model; documentação/narração/handoff que apenas cita o erro não autoriza recuperação. Preservar as proteções contra texto de PTY tomado como prova.

P1 — Watchdog Codex considera início de turno prova suficiente de começo saudável.

Evidência: src/main/orch/tool-util.ts:190 e :1806 definem turnProof apenas para família Claude. src/main/orch/pane-start-watchdog.ts:180 transforma turnOpened em started quando turnProof=false; src/main/orch/delegation-supervisor.ts:902 registra sucesso e remove a ficha.

Reprodução da função pura paneStartProgress com turnOpened:true, worked:false e lastTurnEnd:{outcome:"error", stopFailure:"invalid_request"}:

  turnProof:false → started
  turnProof:true → rejected / provider-request

O prompt pode ter sido entregue e a primeira requisição de inferência continuar inviável. Corrigir esse significado depende de um evento nativo confiável do Codex; não presumir que PostToolUseFailure detectará falha de backend.

Correção mínima imediata: a detecção determinística do P1 anterior aciona failover. Quando houver desfecho confiável Codex, incluir a prova no watchdog. Teste em pane-start-watchdog.test.ts/fluxo supervisor: prompt aceito, zero ferramenta/handoff e erro permanente não pode produzir recordSuccess; a recuperação conserva autoridade e tem tentativa limitada.

P1 — A rotação de modelo pode anunciar sucesso antes do respawn e não encontra outra alternativa quando o default falha.

Evidência: src/main/orch/failover.ts:1068 usa somente migração/default; :1075 retorna undefined se a alternativa é o próprio modelo recusado. Em :1463–1478, switched:next!==undefined sai antes do respawn. Em :1481, main-owned depende de next e conta gerenciada current; erro assíncrono em :1490 apenas gera warning. Essa falha de recibo está demonstrada no código; não executei um respawn real rejeitado nesta auditoria.

Quarentena atual: src/main/orch/model-access-quarantine.ts:12 usa 12 h; :21 identifica apenas adapter/modelo, em memória. Não separa acesso da conta e incompatibilidade da instalação.

Recuperação mínima completa:
1) Detectar a rejeição canônica e registrar indisponibilidade temporária, sem marcar quota/credencial como esgotada.
2) Distinguir recusa de acesso por (CLI, conta, modelo) da incompatibilidade por (CLI, executável/versão, modelo). IDs de conta ficam no Main; não expor rótulos secretos/fingerprints.
3) Escolher alternativa elegível, excluindo recusados/quarentenados e preservando o contrato. Reusar o router e as closures de src/main/orch/tools-panes.ts:2023 se a rotação local não servir; limitar o reroute automático para evitar cascata. Preservar a exclusão do Astra das rotas automáticas.
4) Religamento na mesma conta quando possível; com modelo diferente, usar continuidade autorizada se resume nativo não suportar a mudança.
5) Emitir switched:true somente depois do religamento comprovado. Sem alternativa/erro no respawn, registrar falha e informar o Maestro.
6) Invalidar a quarentena de incompatibilidade quando a instalação muda/prova acesso; expirar a entrada por prazo.

Testes necessários em failover-model-rotation.test.ts e model-access-quarantine.test.ts: default recusado com outro modelo elegível; respawn falha nunca emite switched:true; acesso recusado em A não pune B; instalação nova não herda incompatibilidade da velha; duas rejeições não criam loop.

P2 — Catálogo de modelos e CLI executada têm proveniências independentes.

Evidência: src/main/cli-model-discovery.ts:77 lê ~/.codex/models_cache.json e ignora client_version; src/main/adapter-registry.ts:356 agrega modelos estáticos/customizados/descobertos. src/main/path-resolver.ts:135 põe fallback Homebrew antes de .npm-global/bin (:154); :483 escolhe o primeiro binário executável.

Comandos de versão, após a atualização manual informada:
  /opt/homebrew/bin/codex --version → codex-cli 0.160.0
  /Users/cleofaspereirarocha/.npm-global/bin/codex --version → codex-cli 0.160.0
Leitura restrita do cache: client_version=0.160.0; gpt-6.1-sol listado=true.

Não observei independentemente o binário 0.146.0 anterior; essa parte vem do relato do brief. O mecanismo que permite a divergência foi confirmado no código.

Correção mínima preventiva: carregar proveniência da descoberta e compará-la à instalação resolvida/versão sondada antes da rota/spawn, usando a instalação efetiva como fonte. Divergência deve invalidar a fonte incongruente ou gerar incompatibilidade explícita. Não trocar globalmente a precedência do PATH. Teste com dois executáveis fictícios e cache produzido por instalação diferente.

P2 — F-234 barra sincronização por fast-forward; regex também omite integração cujo destino é implícito.

Evidência: src/main/orch/hook-integration-endpoint.ts:27 usa git\\s+merge\\b[^;&|]*\\b(?:main|master)\\b; :34 aplica sem branch/upstream/histórico. Reprodução da função real transpilada em VM:
  git merge --ff-only origin/main → hit:true
  git merge feature → hit:false
  git push origin main → hit:true

Evidência operacional: main.trace.ndjson, 2026-10-03T13:47:38.055Z:
  kind=integration-review-gate, missionId=mission-809f0e49-d302-49aa-8be1-8dfa5ecaaac9,
  decision=block, reason="árvore suja — commite e peça o veredito do HEAD".

O trace comprova o bloqueio; a associação ao comando exato vem do brief e da reprodução da regex, pois o trace não persiste o comando.

Menor correção segura: conservar o gate e isentar somente sincronização simples verificada. Um alvo remote-tracking, comando --ff-only sem composição/opções ambíguas, branch e upstream correspondentes, Git provando HEAD ancestral do alvo (zero commits locais exclusivos). Resolver refs/remotes/... e revalidar os SHAs observados. Prova ausente mantém o gate. Não liberar todo --ff-only: feature pode integrar assim.

Testes em hook-integration-endpoint.test.ts: igual/atrás do próprio upstream passa; ahead/divergente, branch feature, alvo diferente, mistura com push e cwd ambíguo exigem gate. Além disso, git merge feature na branch main precisa reconhecer integração real; o teste deve examinar destino por Git, não só nome no argv. Os testes atuais :73 não cobrem direção do merge.

P2 — Contrato MCP standard impede entrega somente operacional, embora o gate já admita texto.

Evidência operacional: audit_events do runtime Nexus, 2026-10-03T13:51:01.619Z, nexus_mission_set_status, outcome=error, status=done, missão 809f0e49:
  "missão não pode ficar Concluída sem uma entrega real no projeto..."
O contrato atualmente persistido dessa missão tem lane=standard. O objetivo atual já evoluiu; não o usei como prova do objetivo original de sincronização.

Regra: src/main/orch/mission-delivery-artifact-gate.ts:244. O gate aceita ops/textOnly em :161, consult em :204 e texto operacional em :238. src/main/orch/tools-domain.ts:673/:755 exige nota durável de pelo menos 40 caracteres quando aplicável.

Causa a montante: tools-domain.ts:361 cria via operatorHandMissionContract; src/main/orch/operator-hand-mission.ts:25 não passa lane; src/shared/mission-intent.ts:809 assume standard. Além disso, suggestMissionLaneFromGoal em mission-intent.ts:1045 considera merge escrita; termos ops de :1070 não reconhecem sincronização Git.

Reprodução com funções reais:
  goal="Sincronizar git com git merge --ff-only origin/main"
  suggestedLane=null
  gate standard + resumo preenchido + nenhum arquivo → ok:false, mensagem relatada
  gate ops + mesmas entradas → ok:true

Correção mínima: classificar a categoria de entrega no contrato Main na criação/adoção, reutilizando o classificador existente e reconhecimento estreito de “somente sincronização”. Pedido misto “sincronize e implemente/corrija” permanece standard. Não permitir set_status trocar a categoria retroativamente para escapar do gate. Para missão existente, atualizar contrato de forma canônica ou usar prova operacional Main; não produzir arquivo artificial.

Testes em operator-hand-mission.test.ts/fluxo tools-domain: criação MCP consulta/ops/sync materializa lane correta; sync comprovada e nota ≥40 conclui sem arquivo; nota vaga/pedido misto não usa exceção. Os testes do gate já cobrem ops/consult, mas não provam a criação real MCP.

P1 — Handoff mecânico pode chamar uma entrega incompleta de success sem a revisão Jev do MCP.

Evidência: src/main/orch/turn-end-handoff.ts:333 fixa status success; :552 envia ao caminho PTY. src/main/orch/pty-stream-handoff.ts:355 aplica regressão, mas não reviewMissionHandoff. A revisão está no MCP em src/main/orch/tools-handoff.ts:445. É a pendência expressa em docs/analysis/2026-10-02-review-followups.md:231.

O schema estrito em src/shared/mission-engine-contract.ts:280 contém outcome/summary/evidenceIds/artifactRefs, sem trust/evidência visual estruturada. A copy já mitigada em src/renderer/components/mission/MissionInspector.tsx:50/:936 diz “Resultado registrado” e não atesta validação visual.

Correção proposta: compartilhar avaliação de qualidade entre MCP e fechamento mecânico, adaptando o caminho sem canal de retry. Na falta de prova requerida, preservar texto integral e registrar partial. Tarefa visual precisa de requisito/evidência Main; regex sobre prosa não é verificador universal.

Teste novo em turn-end-handoff/pty-stream-handoff: resposta “não consegui abrir nem inspecionar o preview”, regressão aprovada, zero evidência visual não pode nascer como entrega bem-sucedida verificada. Nenhum caso visual real foi exercitado aqui.

P2 — Telemetria atual não sustenta toda a saúde histórica solicitada.

Evidência: src/main/orch/tools-panes.ts:890 grava tempo/adapter/pane/mission/ok, sem modelo efetivo, sessionId ou versão/binário. src/main/pty/pty-manager.ts:1231 grava saída física, sem motivo estruturado de erro de inferência. src/main/observability/main-trace.ts:12 mantém até 4 arquivos de aproximadamente 5 MB, por tamanho, sem compromisso de retenção de 14 dias. Só havia o corrente.

A auditoria guarda argumentos, sem resultado resolvido; 32 dos 66 spawns aceitos não declaram adapter/modelo. Há perda legítima de histórico operacional: src/main/orch/mission-store.ts:1961 remove missão; src/main/runtime/project-runtime-schema.ts:119/:132 estabelece cascade em panes/handoffs. Isso não prova que toda ausência foi deleção; o caminho free também precisa ser considerado. No runtime atual havia apenas uma linha de pane (orquestrador), apesar de vários workers físicos da missão.

Menor melhoria: eventos seguros de ciclo de vida, com invocation/session/pane, adapter e modelo efetivos, proveniência/versão da CLI, origem classificada da injeção, erro permanente por código, tentativa de recuperação e resultado. Sem texto de prompt, ambiente, argv completo, conta/fingerprint/token. Teste do evento: rota AUTO registra modelo efetivo; rejeição antes do primeiro turno fica distinguível de pane criado; nudges distinguem sistema/Maestro/operador sem guardar conteúdo.

4. Quem mandou “siga” e por que Jev não recuperou

Autoria NÃO VERIFICADA. No runtime, observer.turn_started da sessão pty-musgl60x-2 aparece em:
  2026-10-03T13:59:58.689Z, turn-1, sequence 188;
  2026-10-03T14:01:33.673Z, turn-2, sequence 316;
  2026-10-03T14:02:35.417Z, turn-3, sequence 392.
Prova novos turnos, sem texto/origem da entrada.

Não encontrei nexus_pane_write dessa sessão no intervalo analisado. Os writes históricos guardam text="[REDACTED_TEXT]"; busca do conteúdo na auditoria não pode atribuir “siga”. A busca restrita nos transcripts Claude do projeto também não encontrou a chamada literal. Ausência de registro não prova autoria humana.

Textos automáticos encontrados: src/main/orch/failover.ts:172 usa “The last request was interrupted by a temporary provider issue...”; src/main/orch/worker-handoff-enforcement.ts:168 cobra handoff com texto longo; src/main/orch/tool-util.ts:1807 reentrega o brief inteiro. Não encontrei um auto-nudge literal “siga”.

Jev triage não governa essa recuperação: src/main/jev/jev-terminal-triage.ts:78 classifica falha de comando e devolve orientação. Chamadores src/main/orch/tools-terminal.ts:410 e src/main/orch/hook-triage-endpoint.ts:98 tratam nexus_terminal_run/PostToolUseFailure, não erro de backend Codex. src/main/jev/jev-pane-state.ts:297 é fallback de estado; :360 guarda hint/chip/narra waiting_for_human, sem efeito para errored. src/main/orch/tools-panes.ts:2457 mostra errored/needsHuman no digest ao Maestro.

O needsHuman=0,78 e a tela errored foram informados pelo brief; não recuperei independentemente esse hint volátil. Os observer.status_changed persistidos do Codex permanecem working depois dos turnos. Estado de hook, inferência Jev e liveness físico são sinais diferentes. A correção mínima deve ligar erro canônico ao failover determinístico, com Jev ajudando a explicar, não repetindo a mesma requisição.

5. Métricas dos últimos 14 dias e metodologia

Janela FIXA UTC: 2026-09-19T14:09:11.709Z a 2026-10-03T14:09:11.709Z (até 11:09:11.709 de Brasília). Evitei incorporar os novos workers/handoffs que chegaram enquanto a auditoria continuava.

Fontes sob /Users/cleofaspereirarocha/Library/Application Support/NexusIDE:
• logs/main.trace.ndjson;
• nexus.db;
• project-runtime/projects/*/checkout-*/runtime.sqlite3, conexão file:...?mode=ro;
• snapshots backups/runtime-schema-37-to-40-*.sqlite3, também mode=ro;
• arquivos missions/*/events.jsonl.
Inventário não contou worktrees/node_modules como bancos de produção. Agregação de snapshots/current deduplicou por id e priorizou current. Backups são snapshots históricos, não estados atuais.

nexus.db: zero missions, 14 mission_panes e 3 handoffs, todos os panes/handoffs com datas de julho. Zero eventos desses três conjuntos na janela. Os runtimes são a fonte recente.

Reprodução da contagem, para cada runtime.sqlite3:
  SELECT action, outcome, count(*)
  FROM audit_events
  WHERE occurred_at BETWEEN 1791036551709-14*86400000 AND 1791036551709
  GROUP BY action,outcome;
Para modelos solicitados:
  SELECT json_extract(payload_json,'$.args.adapterId'),
         json_extract(payload_json,'$.args.model'), outcome, count(*)
  FROM audit_events
  WHERE action='nexus_pane_spawn' AND outcome!='intent'
    AND occurred_at BETWEEN 1791036551709-14*86400000 AND 1791036551709
  GROUP BY 1,2,3;

Tentativas MCP: 99 intents, 66 ok, 33 error, zero denied; taxa de recusa 33,3%. São chamadas, não tarefas únicas, e incluem retries/recusas de versões anteriores.

Distribuição por CLI solicitada (aceitas / erros):
  AUTO 32 / 23; Codex 13 / 5; Antigravity 8 / 1;
  Claude 4 / 1; Kimi 4 / 0; Devin 2 / 0;
  GLM Flash 1 / 0; Grok 1 / 2; Qwen 1 / 0; GLM 0 / 1.
AUTO significa adapter ausente nos argumentos. Não imputar sua CLI/modelo a partir da intenção.

Modelos solicitados nos 34 spawns aceitos com CLI explícita:
  Codex: gpt-5.6-sol 4; gpt-5.6-terra 3; gpt-6-sol 2;
         gpt-5.5 1; gpt-6-luna 1; gpt-6-astra 1; default 1.
  Claude: claude-sonnet-5 3; claude-sonnet-4-6 1.
  Antigravity: gemini-3.8-flash-high 3; gemini-3.1-pro-high 1; default 4.
  Kimi: kimi-code/k3 2; default 2.
  Devin: swe-2.5 1; default 1.
  GLM Flash: glm-5.3-flash[1m] 1.
  Grok default 1; Qwen default 1.
Esses são argumentos de auditoria; aliases/atualização de linha podem mudar o modelo efetivo. 48,5% das chamadas aceitas eram AUTO e não têm essa identificação na auditoria.

Motivos das 33 recusas:
  writer ainda ativo 10;
  adapterId ausente 9;
  authority seal indisponível 7;
  renderer ausente 4;
  approval_required 1;
  cwd fora do workspace 1;
  route_required 1.
Exemplos: 27/09 17:47:23.068Z adapterId ausente; 27/09 17:49:59.028Z authority seal indisponível; 28/09 11:14:45.829Z route_required para codex:gpt-6-astra. A maioria não é evidência de regressão atual; inclui guardas e fluxos corrigidos em versões posteriores.

Teto de panes e CLI sem MCP: zero recusas com esses motivos nos registros consultados. Isso não comprova ausência global. Guards atuais: src/main/orch/tools-panes.ts:1690–1710 para capacidade; :232–241 recusa CLI explícita sem MCP no helper sem missão. A rota sem missão também pode excluir CLI antes de tentar spawn (:1077). Dentro de missão há outros transportes de handoff; não generalizar essa recusa a toda CLI de missão.

Roteamento explícito nexus_route_task: 22 chamadas finais ok, zero error na janela. Spawns automáticos não precisam dessa chamada.

Handoffs MCP: 49 intents, 38 ok, 11 error e 2 denied antes do intent; 51 desfechos de chamada. Entre os 49 intents, 22,4% retornaram error. Considerando todos os desfechos, 13/51=25,5% foram error/denied.
Motivos: revisão Jev de evidência/pendências 10; autoridade de contexto ausente 2; replay divergente 1. Estes números medem devolução/recusa de chamada, não 13 tarefas definitivamente falhas.

União current+backup por id: 36 handoffs, sendo success 31, partial 1, progress 2, stalled 2; zero blocked/failed persistidos nesse conjunto. Não confundir com os 11 erros de chamada que podem não ter produzido linha. A partial de 20/09 relata F-356: código/testes concluídos, arquivo QA indisponível na worktree e validação visual pendente.

Evidência de missão presa histórica:
  27/09 17:56:39.581Z, progress: missão 24ef648e “despachada sem tasks/workers no prazo”;
  27/09 18:11:39.771Z, stalled: “ainda sem tasks/workers após uma tentativa”;
  27/09 18:14:54.731Z, progress: “Sem handoff nem arquivos após 23min”;
  27/09 18:15:09.753Z, stalled: instrução de re-rotear.
São handoffs do supervisor, não falhas de worker declaradas por inferência estatística.

Missões: união de snapshots contém 4 criadas na janela (2 failed, 1 blocked no backup; 1 running atual). Só uma permanece no runtime atual: missão 809f0e49 desta investigação. Estava ativa com panes vivos; não classifiquei seu running como travamento. Deleções/ausência de transições impedem calcular taxa histórica confiável de missões presas em running.

Tempo até primeiro handoff final observado: 32 sessões com status success/partial/blocked/failed. Medida derivada do instante no sessionId pty-<Date.now em base36>-contador (src/main/pty/pty-manager.ts:1078), até created_at do primeiro handoff final. Mediana 324,073 s (5min24s), média 527,168 s (8min47s), mínimo 6,389 s, máximo 2763,469 s (46min03s). É tempo desde emissão do ID, não desde primeira inferência, e amostra sobrevivente de sessões que entregaram; não é SLA nem média de todos os spawns. Excluí progress/stalled dessa duração.

Trace: 80 eventos na janela; kind existentes:
  main-boot 19; pane-spawn-timing 21; pty-grid-drift 10;
  mcp-hub-filtered 10; agent-pty-terminate 5; agent-pty-exit 4;
  fast-lane-first-wave 3; head-change-external 3;
  orchestrator-respawned 2; business-model 2; integration-review-gate 1.
Há 21 registros de spawn porque MCP e renderer registram o mesmo pane. Deduplicando os 10 spawns source=mcp por paneId:
  Codex 3; Muse 2; Claude 1; GLM 1; MiMo 1; Devin 1; Antigravity 1.
São workers desta sessão; os eventos disponíveis não cobrem todos os spawns antigos. Trace não contém modelo.

Saídas físicas observadas: 4, todas pane-close e exitCode=0. Muse, Claude e MiMo tinham handoff success anterior; Codex pty-musgl60x-2 não tinha handoff final encontrado. Log Codex:
  2026-10-03T14:05:23.391Z, agent-pty-exit,
  paneId=pane-musgl5yb-2, adapterId=codex,
  uptimeMs=328432, terminationOrigin=pane-close, exitCode=0.
Logo 1/4 das saídas observadas não tem handoff, mas isso é 25% desta amostra pequena e não taxa histórica de mortes. A saída zero por fechamento também não prova execução bem-sucedida.

Leitura única ao vivo por nexus_pane_list, posterior ao corte: seis panes visíveis da missão, cinco busy e um spawning. O orquestrador Claude Opus e workers Codex gpt-6.1-sol, GLM 5.3, Devin swe-2-medium estavam busy; Antigravity gemini-3.8-flash-medium estava spawning. Havia também writer Codex em worktree própria. Estados físicos não provam produtividade/inferência. Não fiz polling.

6. Pendências dos documentos no HEAD auditado

docs/analysis/2026-10-02-orchestration-trace.md:3/:32: comparação controlada Nexus versus CLI direto com mesmas credenciais/modelo/esforço/tarefa continua sem experimento demonstrado. Não atribuir perda de qualidade a esforço/contexto com base no catálogo.

docs/analysis/2026-10-02-review-followups.md:231–246: separação mecânica entre conclusão e validação visual continua aberta; handoff mecânico/schema confirmam a lacuna. A copy de “Resultado registrado” já está aplicada.

Os fixes citados aparecem no código: política dinâmica de subagentes em src/main/orch/native-subagent-policy.ts:20; KeyboardEvent.code/holdMs em src/preload/browser-automation.ts:1040; separação de turnos ACP em src/main/acp/acp-harness-driver.ts:218; preflight redaction em src/main/decision-models/decision-redaction.ts:26; retorno do browser de pane promovido/operatorOpened parked/detached em src/main/orch/pane-registry.ts:689. A presença foi inspecionada; não revalidei todos esses fluxos nesta frente.

docs/analysis/2026-09-28-mission-flow-review.md descreve correções, não um ledger de todas as pendências. O caminho F-175 inspecionado mantém execução por missão em src/main/orch/mission-fast-lane.ts:2117, sem singleton global. Restart/reabertura de CLI real no aplicativo empacotado requer prova de runtime adicional.

Pendências de Linux/restart/instalação/assinatura dos textos pertencem a commits/runs específicos. Não consultei runs novos; não afirmar que continuam falhando no HEAD atual. Esses documentos não tornam esta versão elegível para release.

7. Validação executada e o que NÃO foi verificado

Com PATH=/opt/homebrew/opt/node@22/bin:$PATH, executadas:
  npx vitest run
    src/main/orch/limit-detector.test.ts
    src/main/orch/failover-model-rotation.test.ts
    src/main/orch/model-access-quarantine.test.ts
    src/main/jev/jev-pane-state.test.ts
    src/main/jev/jev-terminal-triage.test.ts
    src/main/orch/hook-delegate-endpoint.test.ts
    src/main/orch/route-tools-reservation.test.ts
Resultado: 7 arquivos, 177 testes passed, 6,77 s.

  npx vitest run
    src/main/orch/hook-integration-endpoint.test.ts
    src/main/orch/integration-review-gate.test.ts
    src/main/orch/mission-delivery-artifact-gate.test.ts
    src/main/orch/jev-handoff-review.test.ts
    src/main/orch/hook-regression-endpoint.test.ts
Resultado: 5 arquivos, 80 testes passed, 10,80 s.

As listas acima representam duas execuções únicas, não uma suíte por linha. Foram feitos também os contrafactuais de detectLimit, paneStartProgress, integrationCommandHit e lane/gate com funções reais. Não há antes/depois de correção porque nenhum código foi alterado. Os testes novos descritos são propostas e não foram escritos, conforme autoridade somente leitura.

Não verificado: autoria do “siga”; binário histórico 0.146.0 após a atualização; todos os modelos efetivamente usados nos 14 dias; denominador histórico de panes mortos/sem handoff; taxa de running preso; recuperação real e qualidade da continuidade após mudar modelo; todos os fixes antigos de browser/ACP; typecheck global/suíte completa; build/instalação/restart/assinatura/notarização/CI atual; inferência comparada Nexus versus CLI; aparência/gameplay.

Não executei testes nativos/Electron darwin-pty neste pane; não os contei como regressão. Não houve tarefa de implementação visual nem preview para inspecionar nesta frente. Nenhuma captura ou aprovação visual foi inventada. A skill graphify foi lida; sem grafo existente, não gerei artifacts porque violaria somente leitura. Consultei diretamente os elos de código.

Prioridade de continuidade: detector/recuperação Codex e recibo de respawn; prevenção catálogo/binário; exceção F-234 com prova Git; categoria operacional na criação; unificação da qualidade do handoff; observabilidade segura. Essas mudanças precisam de testes que reproduzam os casos antes e passem depois. Não há declaração de produção segura nesta auditoria.

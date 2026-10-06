# Teste e ativação do Nexus

Aprovado pelo operador em 05/10/2026: teste de 15 dias com até 6 agentes simultâneos, Pro com agentes simultâneos ilimitados, e medição mínima vinculada à conta, sem código, prompts, nomes de projeto ou conteúdo de entregas.

O Main envia presença a cada minuto e três booleanos: `agentStarted`, `agentWorking`, `missionCompleted`. Início é processo real observado, nunca pedido de spawn. Conclusão é nova transição da missão para `done`, não importação de histórico nem prova de revisão. O Main não envia ids de panes, missões ou providers. Não há upload de backlog depois de logout; falha de rede nunca impede o produto. Login e presença são diferentes.

POST `/v1/activity` exige sessão desktop válida e acesso vigente. Servidor usa seu próprio relógio; mantém presença/primeiros marcos por conta e atividade por dia de Brasília, limitada a 90 dias. Repetir flags não duplica usuários nem dias. DELETE da conta remove registros por FK.

GET `/v1/admin/activity` exige sessão web e administrador autorizado. Dados: `onlineNow` (5 min), `usedToday`, `used7d`, `startedAgents`, `completedMission`, `returned` (dias diferentes), `paidAccounts` (assinatura Stripe ativa com período vigente; sem admin, cortesia, trialing ou inadimplência), `trackedAccounts`, `measuringSince` ISO/null. Exclusão de administradores e cortesias vigentes sem assinatura Stripe real em métricas de ativação; pagamento real prevalece sobre cortesia. Painel explica zero antes da atualização do app e não inventa histórico. Atualiza presença a cada minuto somente com página visível.

A lista distingue última entrada OAuth e último sinal do app, sem chamar contas em teste de online. Assinatura e eventos de uso são observações independentes; sem alegação causal sobre aumento da conversão.

Refinamentos aprovados na continuidade: manutenção diária das CLIs reconhecidas em macOS/Windows/Linux, ligada por padrão somente sem preferência existente, respeitando desligamento e canais manuais. O quadro sinaliza explicitamente ausência de terminal físico e remove navegação para panes obsoletos; nenhum spawn é provocado pelo cartão.

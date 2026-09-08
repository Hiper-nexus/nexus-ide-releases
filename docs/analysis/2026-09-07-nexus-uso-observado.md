# NexusIDE — uso observado em logs locais

Data de coleta: 07/09/2026, 21:21 UTC (18:21 em São Paulo).

O sinal mais importante é que o motor frequentemente tinha arquivos produzidos, mas não conseguia encerrar a cadeia de entrega. No perfil de desenvolvimento, 50 dos 54 registros `worker-died-without-delivery` já continham uma lista de arquivos modificados. Isso não demonstra que os arquivos estavam corretos, mas impede concluir que o agente não trabalhou.

Esta auditoria examina instalação e desenvolvimento **neste computador**. Não há identificação de clientes reais nem de ambiente de produção. Não transformei missões, panes, reinícios ou erros em número de pessoas.

## Fontes e janela

Leitura de `~/.nexus/logs`, `~/Library/Logs/NexusIDE`, logs e `project-runtime` do userData instalado, `.dev-user-data` e três perfis locais de teste/revisão nomeados. São 54 bancos `runtime.sqlite3` ativos em cinco perfis. Backups `runtime-schema-*`, perfis `.bak`, `messages.db`, settings, providers e credenciais foram excluídos da análise. Os dois bancos globais `nexus.db` não tinham missões; apenas essa tabela foi consultada.

Todos os bancos foram abertos por URI SQLite `mode=ro`. Nenhum app, migração, limpeza ou doctor foi executado. As únicas saídas são este documento e `docs/qa/evidence/2026-09-07-autopilot-core/usage-log-summary.json`, agregado sem IDs, títulos, pedidos, nomes de projetos, caminhos pessoais, URLs ou tokens.

Comecei nos últimos sete dias, de 31/08/2026 21:21 UTC a 07/09/2026 21:21 UTC. Como as linhas de missão retidas são mais antigas, ampliei para o histórico disponível: auditoria de 31/07 a 04/09; incidentes de execução e transporte concentrados em 18–25/08. Perfis explicitamente nomeados como testes foram separados. Não é possível provar se cada uso no perfil dev padrão foi manual ou automatizado.

| Origem local | Runtimes | Linhas de missão retidas | Falhas/recusas auditadas no histórico | Últimos 7 dias |
|---|---:|---|---:|---:|
| Aplicativo instalado | 17 | 2 bloqueadas | 102, em 13 referências distintas de missão | 12 |
| Desenvolvimento padrão | 13 | 128: 95 bloqueadas, 33 concluídas | 293, em 69 referências distintas | 6 |
| Três perfis identificáveis de teste/revisão | 24 | 6: 2 bloqueadas, 3 concluídas, 1 em execução | 7 | 0 |

“Bloqueada” não equivale automaticamente a bug ou abandono: 91 das 95 bloqueadas no dev têm `intent_state=blocked_user`; 4 têm `blocked_technical`. O banco não diz sozinho se houve cancelamento, interrupção deliberada ou defeito. Não calculo taxa de sucesso a partir desse estoque de linhas. As 33 concluídas do dev têm MissionResult; 31 têm artifactRefs, duas não. Sem examinar os pedidos, não atribuo defeito a respostas sem artefatos.

Deduplicação: perfil local + `mission_id`; quando esse campo está ausente, recupero somente o escalar `args.missionId`/`args.mission_id` do evento auditado. Isso mede referências a missões, não necessariamente missões ainda existentes na tabela atual. Eventos sem identificador permanecem separados. Uma mesma missão pode aparecer em várias causas; as colunas não devem ser somadas como total de usuários afetados.

## O que existe de recente

Nos últimos sete dias há 18 falhas/recusas auditadas: 12 na instalação e 6 no dev. Entre elas:

- Instalação: seis recusas por exigir o dispatcher, duas chamadas sem dispatch em execução, duas recusas de escopo/contexto, um bloqueio por outro escritor ativo e uma janela Nexus autorizada indisponível.
- Dev: três tentativas de delegação enquanto outro escritor ocupava o checkout, dois argumentos inválidos e uma conclusão recusada por falta de prova do motor.
- Traces registram sete primeiros despachos em seis referências de missão (três por perfil). Todos esses registros mostram `spawned=1,target=1`. Isso documenta tentativas reais nesses perfis, mas não informa o objetivo ou a qualidade da entrega.
- Os bancos consultados não retêm linhas de missão criadas/atualizadas nessa janela. Portanto há lacuna entre os traces recentes e o histórico operacional disponível; não concluo que ninguém tentou criar algo.
- A última primeira onda observada foi em 03/09 no instalado e 31/08 no dev (horário de São Paulo). Há boots posteriores, até 07/09, mas não encontrei uma trilha completa de criação de 06/09 nestes perfis. Os três perfis explícitos de teste são de 08–10/08; a pasta isolada de prova consultada não está mais presente.

As versões de boot recentes vão de 0.71.0 a 0.76.3 no instalado e de 0.70.21 a 0.76.2 no dev. Os logs precedem as correções desta sessão. Testes verdes no checkout não demonstram que o aplicativo instalado já recebeu ou validou esses patches.

## Cinco causas operacionais mais frequentes no histórico dev

Agrupadas por sintoma/código, ordenadas por referências distintas de missão. O grupo heterogêneo “outros” tem 33 eventos em 18 referências; não o trato como uma causa única.

| Etapa / sinal registrado | Dev: eventos / missões | Instalado: eventos / missões | Interpretação |
|---|---:|---:|---|
| Transporte de entrega: timeout, substituição da tentativa, CAS perdido, falha de colagem/Enter, saída do coordenador | 69 / 40 | 6 / 2 | Retentativas e falhas de transporte; nem todas representam perda de entrega |
| Worker encerra sem handoff reconhecido | 54 / 32 | 2 / 2 | 50 eventos dev e um instalado já tinham arquivos modificados |
| Outro escritor ocupa o mesmo checkout | 55 / 23 | 15 / 3 | Proteção de concorrência aparece como erro para o agente quando não há escopo disjunto |
| Operação usa pane sem sessão viva | 46 / 21 | 2 / 1 | Referência de pane ficou sem processo; não prova, isoladamente, crash |
| Repetição de handoff diverge da entrega já registrada | 35 / 18 | 3 / 1 | Payload, origem física ou resultado da repetição não coincidiam com o recibo anterior |

### 1. Transporte e aceite de handoff

Exemplos sanitizados: `accept_timeout`, `accept_superseded`, `acceptance_cas_lost`, `paste_write_failed`.

No dev, a distribuição é 25 timeouts, 17 tentativas suplantadas, dez CAS perdidos, dez falhas de colagem, seis saídas da sessão do coordenador e uma falha no Enter. Todas as 17 `accept_superseded` correspondem hoje a handoffs acknowledged/consumed. Os seis timeouts instalados também terminaram acknowledged/consumed. Logo contar cada evento como missão perdida seria incorreto.

Fonte atual: `src/main/orch/idle-delivery.ts:632-673`, especialmente `handleSubmitNotAccepted`. O código já aceita provas alternativas de leitura/list-ack/novo turno; `docs/qa/items/F-113.md` documenta correção anterior desse problema. Não validei a eficácia dessa versão em uma missão live.

Patches desta sessão: F-137 deixa o coordenador encerrar seu turno enquanto o motor verifica a conclusão; F-139 remove verificações concorrentes. Isso reduz interferência no fechamento, mas **não muda diretamente o protocolo de colagem/ack**. Próxima investigação: distinguir entrega recebida, aceita e consumida sem depender de um edge de TUI; retentar o mesmo recibo de maneira idempotente.

### 2. Encerramento sem handoff, apesar de arquivos presentes

Exemplo sanitizado: `worker-died-without-delivery`, com quantidade de arquivos maior que zero.

Fonte atual: `src/main/orch/mission-fast-lane.ts:1615-1697`. O observador conta a saída sem entrega de handoff mesmo quando `collectFilesModified` encontra arquivos e `settleFastLaneWriterDone` tenta atribuir crédito. O nome do evento não deve ser interpretado como “não produziu código”.

Patches desta sessão: F-136 passa a descobrir arquivos fisicamente por alteração desde o início, inclusive sem Git ou após commit; F-138 analisa working tree/untracked; F-137/F-139 unificam e serializam a conclusão. Esses patches atacam a parte “há código, mas não fecha”. **Não corrigem a causa de um processo que realmente morre antes de trabalhar.** Deve existir uma próxima verificação observada para diferenciar saída normal, saída com resultado e erro do processo.

### 3. Delegação serializada no mesmo checkout

Exemplo sanitizado: `same-checkout delegation is serialized; worker <pane> is still busy`.

Fonte atual: `src/main/orch/same-checkout-fanout.ts:63-91` e `src/main/orch/tools-panes.ts:272`. Sem lista de arquivos de responsabilidade, um novo escritor é bloqueado contra qualquer escritor ativo; footprints que colidem também são rejeitados. É uma proteção contra sobrescrita, não algo a simplesmente remover.

Patches desta sessão: **não resolvem essa família**. O produto pode absorver a decisão no scheduler: filas de trabalho quando há colisão, distribuição automática de escopos disjuntos e troca de estado “aguardando arquivo/equipe” sem pedir ao leigo para escolher worktrees ou CLIs. Esse é um gap diretamente ligado à promessa de orquestração real de vários agentes.

### 4. Pane conhecido, mas sessão já encerrada

Exemplo sanitizado: `pane <pane> has no live session`.

Fonte atual: `src/main/orch/tool-util.ts:241-249`, `authorizedSessionIdOf`; há consumidores equivalentes de design em `src/main/orch/design-send.ts:115,231`. O registro autoriza o pane, mas não encontra sessão viva para leitura/escrita/espera.

Patches desta sessão: a conclusão não mais mantém o coordenador preso esperando seus próprios sensores, mas **não há correção direta de reuso de pane morto**. Próxima investigação: invalidar referências antigas no contexto operacional, retornar substituto atual quando a recuperação estiver autorizada e preservar a entrega antes de fechar a sessão. Nenhuma alegação de que cada caso foi um crash é sustentada pelos logs disponíveis.

### 5. Replay de entrega recusado

Exemplo sanitizado: `handoff replay recusado: payload raw, origem física ou estado diverge do commit existente`.

Fonte atual: `src/main/orch/handoff-store.ts:1172-1199` e `src/main/orch/task-dispatch-handoff-authority.ts:194-218`. A comparação inclui resumo/artefatos/evidências, origem física, HEAD, hash do payload e identidade lógica da operação.

Patches desta sessão: F-139 impede duas verificações de conclusão simultâneas, mas **não altera a regra de replay do handoff**. A proteção deve ser mantida. O próximo trabalho é descobrir por que o retry chega diferente: regeneração de resumo, nova sessão/origem, mudança do código ou duplicação de invocação. Retransmitir o recibo original e abrir uma nova entrega explícita quando o candidato muda são comportamentos distintos.

## Problemas menores em volume, mas próximos das correções atuais

- `completion_proof_required`: 8 eventos em 6 referências dev; 4 em 3 referências instaladas. A nova rota F-137 transforma `done` automático em solicitação ao motor, sem erro por mera espera nem bloqueio do turno; F-134 usa prova main-owned e F-135 separa revisão do candidato atual de reprovações históricas.
- `review_rejected`: quatro eventos na mesma missão dev. Isso comprova repetição da recusa; não prova por si só que todas ocorreram depois de uma correção. O bug de rejeição histórica foi reproduzido em teste nesta sessão e corrigido separadamente.
- `empty_artifacts`: dois eventos em duas referências dev. F-136/F-138 melhoram descoberta e validação de arquivos reais, incluindo projeto novo sem Git e exclusões físicas.
- Credencial ausente: 21 eventos em seis referências dev, dez sem identificação; um na instalação. `spawn-seat-fallback.ts`/F-101 já tratam sucessão de assento para falha de credencial. F-332 melhora a ação de conexão na UI, mas não constitui prova de que toda CLI instalada esteja autenticada.
- F-132 (aprovação stale por HEAD) e F-403 (npm audit error JSON falsamente aprovado) foram reproduzidos em testes de código. Os logs desta amostra não permitem quantificar quantas vezes causaram uma entrega incorreta.

## Atualização, voz e entrada no app

Na última semana, o updater registrou 11 `install:download-source-failed`, mas também nove `install:start` e nove `squirrel:update-downloaded`. `src/main/updater.ts:571` registra uma fonte que falhou antes de tentar outra. Isso é recuperação de download observada, não evidência de 11 instalações inteiramente fracassadas. Não provei que as nove atualizações foram efetivamente instaladas/reiniciadas.

A voz compartilhada registrou dois warnings de fallback em 04/09: a voz principal não estava disponível e houve caminho para voz local. A origem desse arquivo é compartilhada e não permite atribuir cada ocorrência ao app instalado ou ao dev. A configuração de voz não foi aberta.

Também há uma ocorrência recente de “janela Nexus autorizada indisponível” (`tools-vision.ts:55`). Não há logs de login/onboarding/ativação de clientes suficientes para medir abandono antes da primeira criação.

## O que eu priorizaria depois deste fechamento

1. Validar uma missão real curta em instalação limpa: pedido → equipe → arquivo funcionando → revisão/reparo → conclusão, medindo passagem por etapa. Repetir com worker que encerra e deixa arquivo, e com uma entrega que precisa de reparo. Os dados acima dão cenários concretos.
2. Atacar a combinação pane morto + handoff não consumido + retry divergente. O maior gargalo observado está na continuidade do trabalho entre agentes, antes de qualquer debate sobre aparência de sites.
3. Fazer o scheduler absorver a espera por checkout ocupado. O leigo deve ver progresso, não negociar `files`, dispatch, ack ou reserva de rota.
4. Manter diagnóstico por tentativa com código, versão, duração e desfecho; preservar a associação a uma missão sem armazenar o pedido no relatório de suporte. A amostra atual perde essa associação em muitos eventos. **Não implementei tracking novo.**

Não há base aqui para afirmar que “clientes em produção” sofreram estas falhas, que o sistema inteiro nunca conclui ou que todos os sintomas históricos já foram resolvidos pelos patches atuais. Há evidência concreta de trabalho produzido que ficou preso na coordenação, além de erros recentes de uso do dispatcher. Isso é suficiente para orientar a próxima validação do produto, preservando as fronteiras de segurança.

# aNexus — Runtime de missão orientado por intenção

**Data:** 2026-07-13  
**Status:** plano de implementação; nenhuma mudança de runtime incluída  
**Problema:** abrir/selecionar um squad sem objetivo inicia um orquestrador, injeta um playbook amplo e permite que supervisores automáticos fabriquem trabalho de bootstrap. Isso consome tokens e pode manter o usuário esperando por minutos antes de ele sequer informar a missão.

## Decisão

Separar formalmente quatro conceitos que hoje foram colapsados em `running`:

1. **Squad selecionado** — perfil de capacidade escolhido; não é uma autorização de executar.
2. **Objetivo capturado** — pedido explícito, fonte e critérios mínimos conhecidos.
3. **Plano aprovado** — contrato de trabalho, orçamento e riscos definidos.
4. **Trabalho despachado** — somente aqui pode existir orquestrador ativo, tarefas, panes ou `context_doctor` automático.

O fluxo padrão passa a ser **intent-first**: selecionar NavalhaGO deve custar zero tokens de modelo e abrir uma tela de composição, não um CLI com um prompt de execução. A ausência de objetivo é um estado normal (`awaiting_goal`), jamais um stall ou incidente.

## Evidência do problema atual

### Cadeia concreta observada

1. `src/renderer/orch/mission-launcher.ts` cria um pane de CLI ao selecionar o squad.
2. `materializeSquadMission()` persiste a missão e a muda imediatamente para `running`.
3. `buildMissionKickoffPrompt()` concatena instruções do squad, mapa de repositório, roster e um pipeline obrigatório: `context_doctor → freeze_contract → tasks → worktrees → panes → merge`.
4. Caso não exista orientação cacheada, o próprio prompt manda “aquecer o mapa” chamando `nexus_context_doctor`.
5. `src/main/orch/delegation-supervisor.ts` vê uma missão `pending`/`running` cujo squad tem workers, mas sem tarefa nem pane de worker por 90 segundos. Ele entrega ao coordenador um handoff que ordena: “retome agora sem pedir ação ao usuário: rode nexus_context_doctor”.

Portanto, o comportamento relatado não é apenas uma decisão ruim do modelo. O runtime materializa uma missão de execução antes de possuir um contrato e o watchdog transforma corretamente, segundo sua regra atual, a espera do usuário em “ausência de progresso”.

### Falhas de desenho

| Falha | Consequência |
| --- | --- |
| `running` significa tanto “janela aberta” quanto “execução autorizada” | supervisores não distinguem espera legítima de pane travado |
| Prompt inicial contém todo o manual operacional e roster | custo e latência antes de haver tarefa |
| `context_doctor` é bootstrap permitido sem intenção | documentação/drafts passam a competir com o pedido real |
| Supervisor mede apenas tarefas/panes | “aguardando objetivo” vira recuperação forçada |
| A proteção é instrução textual, não gate de runtime | outro handoff pode contradizer a pergunta inicial do agente |
| Squad é tratado como equipe que deve trabalhar | uma seleção simples dispara um fluxo de projeto completo |

## Referências externas — o que aproveitar e o que não copiar

### Overclock instalado

Na inspeção da instalação local, uma missão podia estar marcada como ativa com **0 panes abertos** e panes salvos disponíveis para restauração individual. A interface separa a existência da missão da existência de terminais de agentes. Esse é o princípio útil: missão, sessão e worker são recursos distintos e devem ser ativados sob demanda.

Não copiar: flags de autonomia total de CLIs ou qualquer modelo em que abrir um terminal seja autorização implícita de agir.

### Orca

O Orca oferece a separação correta entre trabalho avulso no terminal e orquestração rastreada: coordenação é usada quando há ownership e dependências. Seu modelo tem tarefas `pending`, `ready`, `dispatched`, `completed`, `failed` e `blocked`, com decision gates explícitos; timeout é checkpoint, não ordem para inventar trabalho. Worktree, terminal e agente também pertencem ao ciclo de uma tarefa, não à mera abertura de um projeto.

O Nexus deve adotar esses princípios, mantendo seus próprios gates PREVC e suas políticas de segurança. Não deve importar o comportamento de agentes com permissões irrestritas.

## Modelo de estado alvo

### Estados de missão

```text
draft
  └─ selecionar squad ──> awaiting_goal
awaiting_goal
  └─ objetivo explícito ─> intent_compiling
intent_compiling
  ├─ contrato inválido/ambíguo ─> awaiting_goal
  └─ contrato pronto ────────> ready_to_start
ready_to_start
  ├─ precisa decisão de risco ─> awaiting_approval
  └─ autorização suficiente ───> dispatched
awaiting_approval
  └─ confirmar ────────────────> dispatched
dispatched ─> executing ─> validating ─> done
                 │
                 ├─ depende de decisão humana ─> blocked_user
                 └─ falha técnica comprovada ──> blocked_technical
```

Regras invariantes:

- `awaiting_goal`, `intent_compiling`, `ready_to_start`, `awaiting_approval` e `blocked_user` **não são estados supervisionáveis por stall**.
- Só `dispatched`, `executing` e `validating` podem entrar na política de recuperação.
- `blocked_user` só volta a ativo por entrada do usuário, não por timer, supervisor ou tentativa de contexto fresco.
- Uma missão sem objetivo nunca recebe tarefas, worktree, worker pane, `context_doctor`, draft review ou comando de terminal.

### Contrato de intenção persistido

Criar uma estrutura pequena e validada, em vez de inferir intenção da conversa em cada reinício:

```ts
interface MissionIntentContract {
  version: 1;
  source: 'typed' | 'voice' | 'imported-issue' | 'automation';
  goal: string;
  acceptanceCriteria: string[];
  risk: 'normal' | 'sensitive' | 'destructive';
  executionMode: 'manual' | 'assisted' | 'autopilot';
  contextPolicy: 'none' | 'minimal' | 'on-demand' | 'prepare-project';
  approvedAt?: number;
  intentVersion: number;
  budgets: {
    planningTokens: number;
    executionTokens: number;
    maxWorkers: number;
  };
}
```

`intentVersion` torna toda mensagem nova do usuário uma preempção explícita: qualquer classificação/preflight pendente de uma versão anterior deve ser cancelada e não pode despachar trabalho atrasado.

## Experiência proposta

### Ao abrir NavalhaGO sem pedido

Mostrar imediatamente:

> **NavalhaGO pronto**  
> Aguardando seu objetivo. Nenhum especialista iniciado. **0 tokens usados.**

Com um campo de objetivo, sugestões locais/cached e ações explícitas:

- **Descrever objetivo** — fluxo normal.
- **Preparar projeto** — única ação que permite o diagnóstico contextual antecipado; explica custo e pode ser cancelada.
- **Abrir terminal vazio** — não inicia agente nem missão.

Não abrir pane de orquestrador. Se compatibilidade temporária exigir abrir um pane, ele deve receber somente uma mensagem de espera de uma linha, sem tools de mutação e sem prompt de playbook.

### Após o usuário informar um objetivo

1. Compilar um contrato curto: objetivo, critérios, risco, escopo provável, papéis necessários e orçamento inicial.
2. Para trabalho normal com pedido explícito, mostrar o plano resumido e oferecer **Começar**; não rodar diagnóstico, tarefa ou worker enquanto o contrato ainda é revisável.
3. Para pagamento, auth, deploy, exclusão, migração ou outro risco sensível, exigir confirmação do plano/impacto.
4. Ao clicar **Começar**, despachar primeiro somente o planejador necessário. Workers adicionais são lazy, por dependência real, e não pelo tamanho do roster.

O usuário pode escrever outra mensagem em qualquer momento. A entrada humana tem prioridade sobre preflight, narração e recuperação automática.

## Arquitetura de runtime

### 1. Manifesto de squad, não prompt monolítico

Converter o squad em dados estruturados:

- capacidades e papéis disponíveis;
- política de risco e limites de workers;
- instruções específicas de cada papel;
- presets de orçamento.

O boot inicial recebe no máximo identidade, estado, ação permitida e referência ao manifesto. As instruções do orquestrador só são compostas ao entrar em `dispatched`; instruções de worker só são carregadas no worker que realmente será criado.

Alvos iniciais de orçamento, a validar por telemetria:

| Fase | Limite | Deve conter |
| --- | ---: | --- |
| Seleção do squad | 0 tokens de LLM | dados locais apenas |
| Compilação de intenção | até 1.200 tokens de entrada / resposta estruturada curta | objetivo e manifesto resumido |
| Plano | até 2.500 tokens de contexto | critérios, risco e referências recuperadas |
| Worker | contexto por tarefa, com teto e hash de fontes | somente arquivos/decisões relevantes |

Não usar esses números como autorização para cortar contexto crítico; são circuit breakers medidos, com saída explícita “preciso de mais contexto” em vez de expansão silenciosa.

### 2. Gate de autoridade no main process

Não basta trocar o prompt. O main process deve validar o estado do contrato antes de liberar efeitos:

| Operação | Antes de `goal` | Antes de aprovação/despacho |
| --- | --- | --- |
| leitura de UI/estado e lista de squads | permitida | permitida |
| criar a casca `draft`/`awaiting_goal` | permitida | permitida |
| `context_doctor`, drafts, code-map refresh | negada, salvo ação **Preparar projeto** explícita | só conforme `contextPolicy` |
| criar tarefas, worktrees, workers/panes | negada | requer `dispatched` |
| terminal, escrita, git, browser externo | negada | continua submetido a PREVC/effect policy |

O gate deve retornar erro estruturado e amigável (`intent_required`, `approval_required`), auditável no log. Isso impede que uma instrução de handoff ou um modelo contorne o estado.

### 3. Supervisor orientado por atividade real

Substituir a regra “tem roster e zero tasks por 90 s” por uma política que opere apenas sobre trabalho despachado.

Sinais válidos de recuperação:

- task `dispatched` sem heartbeat/output após limiar;
- pane morto ou sessão desconectada;
- falha confirmada de provider/conta;
- gate PREVC com dependência técnica não resolvida.

Sinais inválidos de recuperação:

- ausência de objetivo;
- decision gate aberto;
- aprovação humana pendente;
- missão recém-criada ou pane em boot;
- ausência de workers antes de uma decisão de roteamento.

Timeout deve registrar checkpoint e pedir inspeção/espera quando um worker está ativo; não pode produzir `context_doctor`, tarefas ou workers sem contrato. A recuperação precisa ser idempotente, limitada e cancelável, como o Mission Driver já pretende fazer para execuções reais.

### 4. Contexto e memória econômicos

- Armazenar ledger de missão estruturado: objetivo, decisões, critérios, tarefas, evidências, bloqueios, versões de intenção e consumo.
- Recuperar por relevância e hash (`HEAD`, lockfiles, arquivo/feature), não colar mapa completo e manual do squad em toda conversa.
- `context_doctor` torna-se serviço explícito, single-flight, cancelável e cacheado por checkout/revisão. Seus drafts não são automaticamente revisados/commitados durante a espera do usuário.
- Resumo de memória é produzido no fim de cada etapa e somente quando houver delta material. O resumo não deve reintroduzir um playbook inteiro.

### 5. Política de despacho

- Uma pequena tarefa inicia um executor ou leitura dirigida, não o roster completo.
- O planejador pode propor papéis, mas o runtime escolhe `maxWorkers` baseado em dependências comprovadas.
- Task sem dependência não deve esperar “squad completo”; task com dependência recebe gate claro.
- Ações iniciadas pelo usuário podem usar modo `assisted`; `autopilot` deve ser escolha explícita por missão, com orçamento, prazo e superfície permitida visíveis.

## Plano de implementação para a sessão limpa

### Fase 0 — contenção e regressão (primeiro commit)

1. Escrever testes de reprodução do caso NavalhaGO:
   - selecionar squad sem objetivo não cria pane de agente;
   - não grava `running`;
   - não chama `context_doctor`;
   - após 90 s, supervisor não cria handoff;
   - consumo antes do primeiro objetivo permanece zero.
2. Desativar o caminho automático de recovery para missões sem contrato até a migração de estado estar pronta.
3. Instrumentar eventos: `squad_selected`, `goal_submitted`, `intent_compiled`, `plan_approved`, `task_dispatched`, `worker_started`, `automatic_recovery`.

**Critério de aceite:** abrir qualquer squad vazio por 10 minutos não cria terminal de agente, handoff de supervisor, task, draft, comando ou gasto de modelo.

### Fase 1 — domínio e persistência

1. Evoluir `MissionStatus` ou introduzir `intentState` aditivo. Preferir `intentState` inicialmente para preservar compatibilidade com missões existentes e PREVC.
2. Criar schema/migração para `MissionIntentContract` e `intentVersion`, com validação Zod no boundary IPC/MCP.
3. Criar transições puras e testáveis. O main process é a única autoridade para mover `awaiting_goal → ready_to_start → dispatched`.
4. Migrar missões antigas com cuidado:
   - missão `running` com task/pane ativo mantém comportamento;
   - missão sem task, sem worker e sem objetivo torna-se `awaiting_goal`;
   - nunca matar sessão ativa durante a migração.

**Critério de aceite:** o banco consegue distinguir “missão aberta” de “trabalho autorizado”, inclusive após reinício e multi-PC.

### Fase 2 — launcher e UX de intenção

1. Alterar `launchSquadMission`/`materializeSquadMission` para criar uma missão armada, não um pane nem `running`.
2. Implementar o composer acima da lista de squads e estados visuais claros de espera, plano, aprovação e bloqueio.
3. Expor “Preparar projeto” como ação separada, com estimativa de escopo/custo e cancelamento.
4. Garantir que uma nova mensagem do usuário cancele trabalho de intenção ainda pendente.

**Critério de aceite:** “abrir NavalhaGO” responde imediatamente e permite digitar o objetivo sem competição com saída de terminal.

### Fase 3 — compilador de contrato e prompt packing

1. Implementar um compilador curto, com saída JSON validada. Usar classificação determinística onde possível; usar modelo rápido apenas quando o pedido exigir interpretação.
2. Construir prompts por camadas: invariantes mínimos → contrato → contexto recuperado → instrução do papel. Não concatenar roteiro, roster e orientação completos no boot.
3. Mover instruções de `context_doctor` e PREVC para ferramentas/documentação recuperáveis no instante necessário, não para a mensagem inicial.
4. Adicionar limites de tokens, timeout, cancelamento e um fallback que peça esclarecimento sem abrir execução.

**Critério de aceite:** o prompt de pré-objetivo é inexistente; o de planejamento cabe no teto e é auditável por componentes/contagem.

### Fase 4 — supervisor, driver e effect policy

1. Fazer `delegation-supervisor` ignorar qualquer missão não despachada e trocar o critério de “roster esperado” por tasks efetivamente despachadas.
2. Fazer Mission Driver varrer somente execuções autorizadas e tratar `blocked_user`/decision gate como espera, não stall.
3. Aplicar o gate de contrato aos tools de bootstrap/delegação antes do dispatch.
4. Preservar PREVC, evidence-trusted e o comportamento não-destrutivo para panes realmente ativos.

**Critério de aceite:** nenhum mecanismo automático consegue iniciar diagnóstico ou worker em missão que aguarda objetivo/aprovação, mesmo que o LLM tente.

### Fase 5 — telemetria, rollout e reversão

1. Dashboard local por missão: tokens antes do objetivo, tamanho de prompt por camada, tempo até primeiro input, tempo até primeiro dispatch, workers despachados e motivo de cada automação.
2. Feature flag `intentFirstMissionRuntimeV1`, inicialmente opt-in em dev/canary.
3. Executar testes de migração, reinício, dois workspaces, voz/Jarvis, objetivo alterado e provider lento.
4. Ativar por padrão apenas após comparação contra a baseline atual; manter reversão sem migrar dados para trás.

## Suite mínima de testes

- **Unitário:** tabela de transições; supervisor ignora `awaiting_goal`, `awaiting_approval`, `blocked_user`; gate nega efeitos antes do contrato; mudança de `intentVersion` cancela resultado antigo.
- **Integração:** seleção de squad → espera longa → objetivo → plano → início. Verificar zero chamadas ao provider até o objetivo e zero `context_doctor` sem ação explícita.
- **E2E:** input fica utilizável imediatamente; nenhuma conversa automática ocupa o pane; clicar “Preparar projeto” mostra progresso e cancelar interrompe o trabalho.
- **Regressão de execução:** objetivo explícito pequeno despacha somente um papel; auth/pagamentos continuam exigindo revisão/confirmacão apropriada; missão ativa existente continua recuperável.
- **Observabilidade:** cada action automática tem `reason`, `intentVersion`, budget e estado anterior/posterior.

## Métricas de sucesso

| Métrica | Meta |
| --- | --- |
| Tokens de LLM antes do primeiro objetivo | 0 |
| Workers/panes de agente antes de despacho | 0 |
| `context_doctor` automático sem objetivo | 0 |
| Tempo de abrir squad até campo de objetivo utilizável | < 500 ms local |
| Tempo de objetivo explícito até plano curto | < 3 s em provider saudável |
| Tempo até primeiro worker após início aprovado | < 10 s para tarefa simples |
| Recuperações automáticas em estados de espera humana | 0 |

## Não objetivos

- Não importar código do Orca ou do Overclock.
- Não eliminar PREVC, isolamento de checkout, evidence-trusted ou effect policy.
- Não habilitar bypass de permissões de CLI.
- Não tornar `context_doctor` inútil; apenas torná-lo explícito, contextual e cacheado.
- Não obrigar confirmação extra para cada tarefa comum; o objetivo é autorização clara com baixo atrito, não burocracia.

## Resultado esperado no caso relatado

Quando o usuário disser “abra o squad NavalhaGO”, o Nexus mostra NavalhaGO armado, sem terminal de agente e sem custo. Quando ele digitar o objetivo, o sistema compila um contrato curto e mostra exatamente o que será iniciado. Só depois da autorização adequada o Nexus cria o orquestrador e os workers necessários. Se o usuário se ausentar, a missão continua aguardando objetivo — não cria documentação, tarefas ou trabalho fictício.

## Addendum — auditoria KiloCode (13/07/2026)

O KiloCode é uma referência útil de runtime, mas não um pacote para importar inteiro. A licença principal é MIT e permite uso comercial, modificação, distribuição e venda, desde que os avisos sejam preservados; o repositório também declara ser um fork do OpenCode e contém código e dependências de terceiros. Portanto, qualquer cópia deve passar por auditoria de arquivo, SBOM/licenças e `THIRD_PARTY_NOTICES.md`. A recomendação é reimplementar os comportamentos no domínio do Nexus e copiar apenas módulos pequenos, isolados e auditados.

### O que o Kilo resolve que ainda falta no Nexus

1. **Prompt arbiter por sessão.** Cada mensagem recebe sequência monotônica, versão e prioridade. Enquanto uma chamada de modelo ou ferramenta está ativa, uma nova mensagem fica numa fila explícita; ao chegar, a execução verifica `hasFollowup`, cancela/retargeta o trabalho obsoleto e entrega a mensagem nova sem esperar o ciclo antigo terminar. O Nexus tem `intentVersion` e gates de voz, mas ainda não tem esse árbitro genérico para o loop de agente. Esta é a prioridade P0 para o relato “falei e só respondeu minutos depois”.
2. **Contrato pai/filho de tarefas.** O `Task` do Kilo cria contexto isolado, registra `parentID`, limita delegação a um nível, herda negações do pai, propaga custo e devolve um `task_id` retomável em falha. No Nexus, `parentMissionId`/`parentTaskId`, estado terminal, `maxSteps`, custo acumulado e retomada devem ser campos obrigatórios do handoff; um worker nunca deve pedir interação humana nem abrir outro worker por conta própria.
3. **Tetos de permissão herdados.** A regra do pai é um teto: o filho pode ser mais restrito, nunca mais permissivo. Leitura, edição, shell, MCP, diretório externo, pergunta e terminal interativo precisam ser avaliados separadamente, com `allow/ask/deny` e último padrão correspondente. Isso complementa `mission-intent-gate`; não devemos depender de texto no prompt para proteger deploy, pagamentos, remoção ou dados sensíveis.
4. **Compactação e poda com orçamento.** O Kilo poda resultados antigos de ferramentas, preserva uma janela recente e compacta num schema estável (objetivo, restrições, concluído, em andamento, bloqueado, decisões, próximos passos e arquivos). O Nexus deve separar boot invariants, contrato, contexto recuperado e instrução do papel; registrar tokens por camada; compactar antes do limite; e marcar claramente quando contexto foi omitido. Isso evita o prompt monstro e torna custo explicável.
5. **Memória delimitada e segura.** A memória do Kilo é por projeto, tem teto de bytes/tokens, recuperação por relevância, indicador de truncamento e rejeita conteúdo com aparência de segredo. Para o Nexus, adotar um ledger de decisões/descobertas com escopo `workspace + mission`, captura explícita ou por evento confiável, sanitização de segredos e ferramenta de recall sob demanda — não despejar memória inteira no prompt inicial.
6. **Indexação sem bloquear a missão.** O índice semântico do Kilo inicia como worker assíncrono, expõe estado pronto/erro, respeita ignore/permissions e só habilita busca quando está pronto. O mapa determinístico de orientação do Nexus já é uma base mais barata; semantic search deve ser opt-in, local quando possível, cancelável e jamais condição para abrir squad ou enviar a primeira mensagem.
7. **Sessões, worktrees e checkpoints.** O Agent Manager do Kilo separa sessão, branch/worktree, terminal e revisão; checkpoints ficam fora do projeto e permitem revert/redo. O Nexus já possui PREVC, evidência e isolamento: devemos conectar esses recursos ao ciclo da tarefa (checkpoint antes de mutação, diff/review/apply, rollback), sem trocar a autoridade do PREVC por snapshots do Kilo.

### O que não copiar

- Não importar `packages/opencode` ou `kilo-vscode` inteiros: são um runtime grande com pressupostos próprios de Bun/Effect/Drizzle/OpenCode, além de superfície de dependências e licença de terceiros.
- Não copiar o modo `kilo run --auto`/bypass. A própria documentação alerta que ele desativa confirmações; no Nexus o padrão deve continuar fail-closed, perguntando apenas para efeitos sensíveis/destrutivos conforme o contrato.
- Não replicar o antigo “orchestrator mode” como segundo cérebro. O Kilo hoje favorece agentes completos delegando tarefas isoladas; no Nexus, o Intent Contract deve continuar sendo a autoridade única.
- Não colocar roster, documentação, doctor ou índice inteiro no kickoff. Perfil de agente deve carregar prompt, modelo e ferramentas sob demanda.

### Ordem de implementação recomendada

**P0 — fluidez e controle:** `MissionPromptQueue` no main process; sequência/versão/cancelamento; preempção segura entre etapas LLM/tool; UI de “executando / nova mensagem enfileirada / cancelada”; testes de mensagem durante chamada lenta e provider indisponível.

**P0 — segurança de handoff:** contrato pai/filho, um nível de delegação, `maxSteps`, orçamento de tokens/custo, negações herdadas e falha retomável; integrar ao `task-router`, `delegation-supervisor` e `mission-intent-gate`.

**P1 — contexto econômico:** compaction schema, poda de tool output, memória delimitada/recall e métricas de tokens por camada. Só então medir se semantic indexing é necessário além do orientation map.

**P1 — operação reversível:** checkpoint por tarefa, revisão de diff e lifecycle de worktree; manter PREVC/evidence-trusted como fonte de verdade.

**P2 — rollout:** ativar atrás de `intentFirstMissionRuntimeV1`, testar voz/Jarvis, multi-workspace, objetivo alterado e cancelamento; remover caminhos legados apenas depois de telemetria provar paridade.

### Critérios de aceite adicionais

- Uma mensagem nova do usuário pode cancelar ou ultrapassar uma preflight/doctor não essencial em até um ciclo de ferramenta, sem aguardar minutos.
- Nenhum filho excede as negações do pai, cria neto ou fica bloqueado esperando pergunta humana.
- O orçamento de uma missão inclui pai + filhos e é interrompido ao atingir `maxSteps`/custo.
- Um prompt de execução pode ser reconstruído por camadas e seu tamanho/tokens aparecem no log.
- Índice, memória e checkpoint indisponíveis degradam para fluxo determinístico; nunca impedem abrir, esclarecer ou cancelar missão.

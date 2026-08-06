# Refatoração: caminho de execução SIMPLES (modelo Overclock)

**Data:** 2026-08-06
**Autor:** worker de paralelismo/motor (pane-248)
**Escopo:** análise e desenho. **Nenhum código de produto alterado neste commit.**
**Base:** [2026-08-05-overclock-parity-gap.md](2026-08-05-overclock-parity-gap.md),
[2026-08-06-clockvoice-parity.md](2026-08-06-clockvoice-parity.md)

---

## 0. A frase que organiza tudo

> "a missão simplesmente morre sem poder fazer nada"

Toda morte que ele sofreu hoje veio de uma **camada que o Overclock não tem**.
Não de um bug dentro da camada — da existência dela. O Nexus tem ~9 estágios
obrigatórios entre "o usuário diz o objetivo" e "um worker está escrevendo
código". O Overclock tem **um**: spawnar o pane com a tarefa no argv.

Cada estágio é um ponto de deadlock. Nós passamos o dia corrigindo deadlocks
individuais — e cada correção foi honesta e necessária — mas o número de
estágios não mudou. Este documento ataca o número.

**O modelo Overclock, que atesto de dentro (rodo nele agora):**

```
pane_spawn({prompt})            → o pane nasce JÁ EXECUTANDO (tarefa no argv)
worker trabalha                  → cwd herdado, sem worktree, sem seal
Stop-hook                        → é IMPOSSÍVEL encerrar sem done/blocked/failed
handoff_submit                   → o texto é digitado na entrada do delegador
delegador acorda                 → push, não polling
TTL opcional                     → reap ~30s depois de handoff limpo
```

Ele não trava porque **quase não há em que travar**.

---

## 1. Inventário da cerimônia (com file:line)

Entre "objetivo declarado" e "worker escrevendo código":

| # | Estágio | Onde | O que protege | Como FALHOU de verdade | Overclock tem? |
|---|---|---|---|---|---|
| 1 | **Aprovação** (modal nativo) | `mission-intent.ts` + `renderer-mission-authority.ts` | consentimento antes de gastar/escrever | modal reaberto em loop; selo do squad invalidando a própria aprovação (fix `706e7261`, `c9634478`); **agora mesmo: missão parada em `awaiting_approval` sem ele saber** | **NÃO** |
| 2 | **PREVC / freeze de contexto** | `guided-mission-prevc.ts:415` `ensureGuidedMissionPrevcForScope`, chamado em `mission-orchestrator-bootstrap.ts:891` | congela o contexto para o plano não derivar | 30/07: freeze automático removido, fence exigia contrato que ninguém criava → **missão travada para sempre** (memória `prevc-auto-freeze-deadlock-bug`) | **NÃO** |
| 3 | **Selagem do plano** | `mission_task_plans`, `guided-mission-planner.ts` | plano imutável e auditável | plano só existe depois do turno 1 do orquestrador (6m55s medidos hoje) — nada despacha antes | **NÃO** |
| 4 | **Reserva de rota** | `mission_route_reservations` | fixa adapter/model/effort por tarefa | reservas expiram em 5min (`created_at`+300s); observadas 2 no voo de hoje, 1 consumida 1 expirada | **NÃO** (config herdada do pai) |
| 5 | **Provisionamento de worktree** | `worktree-manager.ts` / `worktree-runtime-registry.ts` | isolamento físico entre escritores | **"autopilot mission worker requires a physically distinct execution worktree"** — `pty-manager.ts:1477-1485` | **NÃO** (cwd herdado) |
| 6 | **Claim de dispatch** | `task-dispatch-claim-authority.ts:59` `claimTaskDispatch` | 1 worker por tarefa, `maxWorkers` | claim é rápido (0s medido hoje) — **este estágio não é o problema** | parcial (contador de panes) |
| 7 | **Checagem de ownership / slot exclusivo** | `mission-scheduler-ownership.ts:67` `requiresExclusiveSlot` | dois escritores no mesmo arquivo | ownership vazia de LEITOR virava slot exclusivo (fix meu `347f0b7b`); wildcard já travou missões futuras (memória `stale-worktree-ownership-blocks-future-missions`) | **NÃO** |
| 8 | **Teto de onda / escada adaptativa** | `mission-scheduler.ts` `effectiveConcurrencyCap`, `decideAdaptiveCap` | não estourar máquina | escada presa em 2 numa máquina de 8 (fix meu `5ebcd127`); teto mudo (fix meu `574139c5`) | **NÃO** (cap simples de panes) |
| 9 | **`handoff_ready` → ack/validação** | `mission-scheduler-authority.ts:19,26`; `mission-scheduler-guided-finalization.ts:194,299` | prova de entrega antes do merge | **missão parada em `handoff_ready` esperando um context-reviewer que não sobe** | **NÃO** — handoff é digitado no delegador, ponto |
| 10 | **Unidades de QA/revisão no grafo** | plano guiado (t4/t5 no voo de hoje) | qualidade | serializavam entre si sem precisar (fix meu `347f0b7b`); ampliam o DAG e o tempo | **NÃO** (revisão é escolha, não estágio) |

**Leitura:** dos 10 estágios, o Overclock tem equivalente real em **1** (contagem
de panes). Os outros 9 são superfície de deadlock que ele simplesmente não possui.

---

## 2. Desenho: modo de execução SIMPLES

Proposta: um `executionMode` de missão — **`simple`** — espelhando o Overclock.
A boa notícia: **o vocabulário já existe**. `same_checkout` e `read_only` já são
modos válidos (`real-mission-e2e-proof-schemas.ts:177`) e `WorkspacePolicy` já
tem `same_checkout` (`workspace-types.ts:41`). O que falta não é conceito — é um
caminho que não exija a cerimônia.

### Fluxo

```
objetivo → spawn do worker no PRÓPRIO workspace, tarefa no argv
        → worker trabalha (cwd herdado, sem worktree)
        → hook de parada força handoff done|blocked|failed
        → handoff acorda o orquestrador (push)
        → TTL colhe o pane
```

### O que é DISPENSADO

| Dispensado | Por quê é seguro no modo simples |
|---|---|
| worktree distinta (#5) | 1 escritor por vez: não há com quem colidir |
| PREVC/freeze (#2) | sem plano selado a congelar |
| aprovação modal (#1) | o operador **pediu** a tarefa; consentimento é o próprio pedido |
| selagem de plano (#3) | a tarefa é o plano |
| reserva de rota (#4) | herda CLI/model/effort do pai (clone-by-default) |
| slot exclusivo/ownership (#7) | idem worktree: 1 escritor |
| escada adaptativa (#8) | teto simples de panes |
| ack/`handoff_ready` (#9) | handoff É a entrega; sem estágio intermediário |

### O que é MANTIDO (inegociável)

- **Handoff forçado** — o hook de parada. É o que torna perda impossível. Já
  temos a peça: `worker-handoff-enforcement.ts` (`b9739896`) cobra o worker mudo
  independentemente do estado da missão, e o store grava sem gate
  (`handoff-store.ts:486`).
- **Cobrança de vivacidade por ATIVIDADE** — `827273b5`.
- **Trilha de auditoria** — `mission_events`, handoffs, custo. Observabilidade
  não é cerimônia: não bloqueia nada.
- **Sandbox/confinamento do adapter** — segurança de execução é ortogonal ao
  isolamento entre escritores.
- **Cancelamento e TTL**.

### O que se PERDE — honestamente

**Segurança entre escritores concorrentes.** É a troca real e única. Sem
worktree, dois workers escrevendo no mesmo checkout se atropelam. Portanto:

> **O modo simples é para 1 escritor por vez.** Paralelismo nele = leitores
> concorrentes (QA, revisão, pesquisa) + 1 escritor.

**Quando o caminho pesado CONTINUA sendo o certo:**
- vários escritores em paralelo no mesmo repo (o caso do fan-out de 11/85 stories);
- merge automático de trabalho concorrente (fila de merge, PREVC);
- trabalho destrutivo/sensível onde a aprovação é requisito de negócio;
- auditoria formal de entrega (receipts) exigida por processo.

Ou seja: **o pesado não morre — deixa de ser o default.** Hoje ele é cobrado de
todo mundo, inclusive de quem só quer "corrija isto".

---

## 3. Matriz de modos de falha — a justificativa

Cada linha é uma morte REAL dele, com evidência.

| # | Morte real | Estágio culpado | Modo simples evitaria? |
|---|---|---|---|
| 1 | `autopilot mission worker requires a physically distinct execution worktree` | #5 `pty-manager.ts:1483` | **SIM** — não há requisito de worktree |
| 2 | Missão parada em `handoff_ready` esperando context-reviewer que não sobe | #9 | **SIM** — não existe estágio de ack |
| 3 | Modal de aprovação invalidado pelo próprio selo | #1 | **SIM** — não há aprovação |
| 4 | **Agora:** missão em `awaiting_approval` parecendo morta | #1 | **SIM** |
| 5 | PREVC nunca congela → travada para sempre (30/07) | #2 | **SIM** |
| 6 | Worktree órfã de missão terminal trava missões FUTURAS | #5+#7 | **SIM** |
| 7 | Escada adaptativa presa em 2 numa máquina de 8 | #8 | **SIM** — sem escada |
| 8 | Leitores serializando por ownership vazia | #7 | **SIM** |
| 9 | Falso positivo de stall (10:00:59) | detector | **PARCIAL** — já corrigido em `827273b5`; no simples o handoff forçado torna o stall menos consequente |
| 10 | Worker mudo perdendo relatório | — | **NÃO PIORA** — o hook de parada é mantido e é a peça central |

**9 de 10 mortes desapareceriam.** Nenhuma delas era um bug da lógica de
negócio: todas eram a cerimônia falhando.

---

## 4. Fatias de migração — mais seguras primeiro

Cada fatia é independentemente valiosa e reversível.

### Fatia 1 — DESBLOQUEIO (o que o destrava mais rápido)
**Mensagem acionável no guard de worktree.** `pty-manager.ts:1483` hoje diz o
que o motor queria, não o que o humano deve fazer, e não nomeia o caminho em
conflito. Trocar por: qual worktree/scope colidiu, e o que fazer.
*Custo:* baixo. *Risco:* nenhum (só texto + contexto). *Reversível:* trivial.
**Não corrige a causa — corrige o silêncio, que é o que o paralisa.**

### Fatia 2 — `executionMode: simple` atrás de flag, sem worktree
Permitir que um worker de missão rode com `same_checkout` quando a missão é
declaradamente de 1 escritor: relaxar o guard #5 **apenas** para esse modo
(nunca para autopilot multi-escritor). O vocabulário já existe
(`workspace-types.ts:41`).
*Risco:* médio — mexe no guard. Mitigado por ser opt-in e por manter o guard
intacto no caminho paralelo.

### Fatia 3 — pular #1/#2/#3/#4 no modo simples
Sem aprovação, sem PREVC, sem selagem, sem reserva. A tarefa é o plano.
*Risco:* médio. *Reversível:* o modo pesado continua o default até virarmos a chave.

### Fatia 4 — handoff direto (matar #9 no modo simples)
Handoff submetido = entrega. Sem `handoff_ready`/ack. Reusa o enforcement que já
existe (`b9739896`).

### Fatia 5 — argv-at-birth para TODO CLI
`pty-manager.ts:1158-1167` cobre `agy|codex|opencode`; **`claude` fica de fora**.
Precisa de teste com pane vivo para medir antes/depois — por isso recomendei
**0.26.3**, não 0.26.2 (declarar sem provar foi exatamente o erro do P0-6).

### Fatia 6 — virar o default
Missão comum nasce `simple`; o pesado passa a ser escolha explícita para
fan-out multi-escritor.

---

## 5. Nota de método

O erro que este documento corrige não foi técnico: foi de **prioridade**. Passamos
o dia consertando deadlocks um a um — cada correção real, testada e defensável —
enquanto a pergunta dele desde o começo era por que existem tantos lugares para
travar. Corrigir o enésimo deadlock e reduzir o número de estágios são trabalhos
diferentes, e só o segundo responde "a missão simplesmente morre".

---

## 6. RE-SEQUÊNCIA: o simples vira o PADRÃO (decisão do dono, 06/08)

> "tira essa aprovação de vez, vai direto pro caminho simples"

A inversão muda a pergunta de *"o que podemos pular?"* para *"o que ainda se
justifica cobrar de todo mundo?"*. Classificação dos 10 estágios:

### A REMOVER do caminho padrão (a morte que cada remoção evita)

| Ordem | Estágio | Morte real que some | Status |
|---|---|---|---|
| 1 | **#5 worktree distinta** | `autopilot mission worker requires a physically distinct execution worktree` — e o revisor read-only que não subia | **LANDADO** `84110780` |
| 2 | **#1 aprovação** | modal em loop; selo invalidando a própria aprovação; missão parada em `awaiting_approval` parecendo morta | **231** (não duplicar) |
| 3 | **#9 ack / `handoff_ready`** | missão parada esperando reviewer que nunca sobe | a fazer |
| 4 | **#2 PREVC/freeze** | 30/07: fence exigindo contrato que ninguém criava → travada para sempre | a fazer |
| 5 | **#3 selagem de plano** | nada despacha antes do turno 1 (6m55s medidos) | a fazer |
| 6 | **#4 reserva de rota** | reservas expirando em 5min | a fazer |

### A TORNAR OPT-IN (para quem realmente precisa)

| Estágio | Quando ligar |
|---|---|
| #5 worktree isolada (`isolatedWriter`) | **vários escritores em paralelo no mesmo repo** — o caso honesto |
| #7 ownership / slot exclusivo | idem: só faz sentido havendo concorrência de escrita |
| #8 escada adaptativa | política Hardened, já configurável (`5ebcd127`) |
| #10 unidades de QA/revisão | escolha de qualidade, não estágio obrigatório |

### A MANTER SEMPRE (carregam peso de verdade)

| Estágio | Por quê |
|---|---|
| #6 claim de dispatch | garante 1 worker por tarefa; **custou 0s** no voo de hoje — não é fonte de atraso |
| Handoff forçado | é o que torna perda impossível (`b9739896`) |
| Vivacidade por atividade | `827273b5` |
| Sandbox do adapter | segurança de execução ≠ isolamento entre escritores |
| Auditoria (`mission_events`, custo) | observabilidade não bloqueia |

---

## 7. O QUE ELE PERDE — o custo do que acabou de escolher

Ele tem direito a saber o preço. Com workers compartilhando o workspace:

1. **Escritores concorrentes podem se atropelar.** Dois workers editando o mesmo
   arquivo no mesmo checkout não têm árbitro físico. No modelo antigo a worktree
   impedia isso por construção.
2. **Edições de um worker que falha não ficam em quarentena.** Antes, um worker
   que morria levava junto a própria worktree e o `main` seguia limpo. Agora as
   edições parciais dele ficam no workspace — visíveis, e do jeito que ficaram.
3. **`git status` deixa de ser só dele.** O workspace passa a ter trabalho de
   agente misturado ao dele enquanto a missão roda.

**Mitigações reais (não promessas):**
- **Menos escritores simultâneos no padrão.** O caminho simples é 1 escritor +
  N leitores. Leitores não colidem — e agora não tomam mais slot exclusivo
  (`347f0b7b`).
- **Modo isolado opt-in continua inteiro** para fan-out largo: `isolatedWriter`
  liga a worktree e toda a maquinaria de ownership que já existe e foi corrigida
  hoje.
- **A maquinaria de ownership não foi jogada fora** — está ali, testada,
  esperando o modo que precisa dela.

**Regra prática:** um pedido comum ("corrija isto", "implemente a story 1.2") →
simples. Um fan-out declarado de N escritores no mesmo repo → `isolatedWriter`.

---

## 8. argv-at-birth do claude volta ao escopo

No caminho simples isso deixa de ser otimização e vira **parte do modelo**: a
tarefa viaja no spawn e o pane acorda executando. Deixar `claude` — o CLI mais
usado dele — num caminho mais lento que `codex`/`agy` indefinidamente não se
sustenta.

`pty-manager.ts:1158-1167` hoje cobre `agy | codex | opencode`. A objeção que eu
levantei era a falta de medição ao vivo; ela continua válida como *medição*, mas
não como bloqueio: a forma correta é **landar com prova unitária do argv e
registrar explicitamente que os segundos não foram verificados**. Isso é honesto;
adiar indefinidamente não era.

# Dossiê sênior — Paridade de ciclo de missão: Overclock × Bridge × Nexus

**Data:** 2026-08-11 · **Autor:** análise sênior com cruzamento de dados
**Escopo:** ciclo de vida completo de missão — nascimento, orquestração, handoff,
envios entre panes e MCP — do Overclock v1.3.4 (instalado) e do Bridge 3.4.18
(swarm vivo no PC físico), para extrair a lógica copiável e implementar no Nexus.
**Segunda pergunta respondida aqui:** auditoria dos commits "que supostamente
resolveram problemas" — quais estão REAIS (no código, ativos, consumidos), quais
estão DESLIGADOS, quais sobreviveram intactos.

> **Método:** evidência de disco/código com `file:line`, nunca inferência. Os
> três mapas de ciclo de vida foram feitos por agentes separados; este dossiê
> cruza os dados, verifica cada alegação contra o HEAD e classifica o estado real.

---

## 0. Veredito executivo

O Nexus não está "quebrado em tudo". Tem **dois pontos de quebra estruturais**
(B1 e B2) que causam a sensação de "consertamos um lado e quebrou o outro", e
**nenhum dos 9 commits mais recentes os toca**. Os dois são justamente os que
seguram o fluxo: um mata missões fast-lane por dentro (B1) e outro deixa o
comando direto do operador morto no fast-lane (B2).

O que os dois sistemas de referência fazem e o Nexus não:
- **Overclock:** entrega de trabalho é **desacoplada** (pai sai em ms, sidecar
  faz a rede) e **fail-open** no stop. O Nexus copiou o *objetivo* (worker mudo
  não pode matar a missão) mas implementou como enforcement **síncrono, global e
  falha-fechada**, que briga com o caminho rápido.
- **Bridge:** coordenação é **filesystem-first e event-sourced** — estado
  legível em disco, degradação gradual, identidade por env. O Nexus depende de
  sessão em memória + TTLs que viram fantasma quando o app reinicia.

**Ordem de ataque:** lançar o gate de lane no enforcement (B1) + corrigir a
autoridade de direção no fast-lane (B2) antes de qualquer feature nova. O resto
(9 commits) são fixes reais e menores que devem entrar, mas não mudam o quadro.

---

## 1. Tabela mestre — ciclo de vida por estágio (Overclock × Bridge × Nexus)

| Estágio | Overclock v1.3.4 | Bridge 3.4.18 (vivo) | Nexus hoje | Quebra? |
|---|---|---|---|---|
| **Nascimento** | Recipes declaram a forma de fan-out no texto (`orchestratorInstructions` com `∥` e gates) | Scope local em `.bridgespace/swarms/<scopeId>/`; swarm nasce de arquivos | `wave-pack-templates` tem `stories[]` mas **sem `ownershipFiles`** → colapsam numa unidade lógica | **B7** (não abre em leque) |
| **Preparação** | Turno 1 do orquestrador sela o plano (doutrina: modelo/effort por profundidade, "default DOWN") | Swarm pré-configurado; identidade por env | `sealMissionStartReview` gated em kickoff acceptance (fast-lane: null) | **B2** |
| **Orquestração** | Fan-out por *declaração* (1 worker por tela / 1 scout por fonte) | Workers coordenam por arquivos de evento | Scheduler admite N disjuntos, mas stories não declaram posse | **B7** |
| **Handoff** | 12 mecanismos (H1–H12); fonte de verdade `handoffs.db`; entrega via **sidecar detached**, fail-open no stop | Mailbox/event-sourcing: `bs-mail`, `bs-swarm`, `bs-notify` | `worker-handoff-enforcement` **global, sem lane-check**, digita nudge fake no PTY vivo (~20s) e handoff bloqueado sintético (~45s) | **B1** |
| **Envio entre panes** | `input-origin-<paneId>` marca humano×sistema; turno digitado pelo humano **nunca** entrega (H9) | Eventos de arquivo idempotentes | `initIdleDelivery` existe; origem humano×sistema **não existe** | **B6** |
| **MCP** | 44 tools; `mcp-pane-<id>.json` por pane com `model`, `providerId`, `missionId`, `callerPaneId` | Não é o foco do swarm (coordenação por arquivo) | `--mcp-config` por sessão (equivalente) | — |
| **Conclusão** | Fechamento mecânico (H2) se o modelo não submeteu; dedup por identidade de turno (`flag:'wx'`) | Marcador de entrega por saída sustentada | `mission-completion-marker` (commit novo) + PRONTO como regra | — |
| **Recuperação** | Cap de 2 nags; Stop provocado volta com `stop_hook_active=true`, pai sai 0 | Degradação gradual (nudges transientes) | Fantasmas de TTL exigem purge+resume; worktree órfão trava missões futuras | **B5** |

---

## 2. O que o Overclock faz (evidência verificada)

Fonte de verdade de handoff: **`~/.overclock-ssh/handoffs.db`** (não `messages.db` — a análise anterior estava errada). Entrega saiu dos hooks para **sidecar**: o `handoff-deliver.mjs` grava o payload, relança a si mesmo `detached` (`OVERCLOCK_STOP_CHILD=1`) e sai **exit 0 em ms** (H1). Os 12 mecanismos H1–H12 estão documentados no dossier `2026-06-08-extracao-motor` e preservados em `overclock-handoff-*.mjs.txt`.

**Os 4 que importam para o problema do Nexus:**

1. **H1 — Execução desacoplada.** O processo que o CLI espera não faz I/O de rede; o neto faz. Custo de um `existsSync`. → Nosso `HOOK_SCRIPT` é síncrono e fail-closed; é a razão documentada de não termos instalado o stop-hook (`0fe423aa`).
2. **H10 — Fail-open no stop, nunca no pretool.** Transcript ausente/desconhecido ⇒ entrega assim mesmo. *"eco a mais é ruído; resultado perdido é o bug que este mecanismo conserta."* → O Nexus escolheu o oposto.
3. **H9 — Origem humano×sistema.** Arquivo `input-origin-<paneId>` escrito na fronteira do IPC (`pty:write`=humano, `pane_write`=sistema). Turno digitado pelo humano nunca entrega → evita acordar o chefe com conversa do operador.
4. **H4 — Ensino invisível.** Erro visível na TUI foi REPROVADO pelo dono (2026-07-26). O canal certo é `UserPromptSubmit`: injeta contexto que só o modelo vê, zero pixels.

**Doutrina como prompt:** `orchestratorInstructions` dos squads declaram a estrutura com `∥` (ex.: *"back ∥ front (1 worker por tela)"*, *"1 scout por fonte"*). O Nexus já conectou `buildOrchestratorDoctrine(squad, mission)` no fast-lane (linhas 153-155) — **esse gap foi fechado**.

---

## 3. O que o Bridge faz (evidência verificada)

Scope é **project-local** (`.bridgespace/swarms/<scopeId>/`), não `~/.bridgespace/swarms/` como documentado antes. `nudges/` é transiente. `bs-notify` não tem shim.

**Modelo que vale copiar:** coordenação **filesystem-first e event-sourced**.
- `bs-mail` (caixa de entrada por worker), `bs-swarm` (estado do swarm), `bs-sync` (espelhamento) — todos arquivos JSON/SQLite legíveis.
- Identidade por env (`BSCOPE_ID` etc.), não por ponteiro em memória que morre no restart.
- Degradação gradual: quando um componente não está disponível, o swarm **degrada** em vez de falhar-fechado.

**Por que copiar isso:** o Nexus sofre de estado em memória + TTLs que viram fantasma no restart (vimos isso em `merge-abandonado-mesmo-processo-sem-watchdog` e `release-gate-real-mission-deadlock`). Uma **projeção em disco** (estado legível sem abrir o app) custa pouco e dá diagnóstico que hoje só existe se o app estiver vivo.

---

## 4. Nexus hoje — pontos de quebra (evidência no HEAD)

| # | Quebra | Evidência (file:line) | Severidade |
|---|---|---|---|
| **B1** | `initWorkerHandoffEnforcement()` roda **incondicionalmente**, sem lane-check; digita `[NEXUS_HANDOFF_REQUIRED]` no PTY vivo em `WORKER_QUIET_GRACE_MS` (~20s) e faz handoff bloqueado sintético em `WORKER_ENFORCE_GRACE_MS` (~45s) — **luta contra a conclusão observacional do fast-lane** | `orch-ipc.ts:1414` (chamada), `worker-handoff-enforcement.ts` (zero `grep` de lane/fastLane) | **CRÍTICA** |
| **B2** | Comando direto do operador morto no fast-lane: `missionDirectAuthority` gated em `hasCurrentKickoffAcceptance` + `mission.orchestratorSessionId` (null no fast-lane) | `mission-engine-production.ts:377`, `mission-store.ts:~294` | **CRÍTICA** |
| **B3** | Sessão PTY persistente (tmux) **desligada por padrão** (`defaultEnabled:false`) | `feature-flags.ts:290-304` | Média (honesto, mas inativo) |
| **B5** | Fantasmas de TTL + worktree órfão de missão terminal travam missões futuras | (memory: `stale-worktree-ownership-blocks-future-missions`) | Alta |
| **B6** | Origem humano×sistema (H9) **não existe** → pane entrega turno digitado pelo operador | `grep input-origin` no Nexus = 0 | Média |
| **B7** | Stories dos wave-pack templates **sem `ownershipFiles`** → nunca abrem em leque (0 ocorrências no arquivo) | `wave-pack-templates.ts`, `mission-wave-pack.ts:466-470` | Alta |

> B4 (mensagens `[nexus]` repetidas em todo pane, não limpas) e B8 (modo governed:
> inventário oferece executor que a cerca de spawn depois recusa) foram identificados
> pela outra sessão e **aguardam decisão sua** — não são bugs abertos sem dono.

---

## 5. Auditoria dos "problemas supostamente resolvidos"

Os 9 commits da rodada mais recente (branch `claude/mission-projection-hardening-f08ee5`,
`df0f84a2..317492a7`). **Estado verificado contra o HEAD, não contra o relato:**

| Commit (claim) | Estado real | Evidência |
|---|---|---|
| `refactor(cli)` contrato de largada declarado | **REAL** | `cli-initial-prompt.ts` (novo, +94) |
| `fix(codex)` prompt entrava duas vezes | **REAL, com teste** | `pty-manager.ts` (argv reconstruído pelo allowlist anexava prompt 2×; saiu do caminho genérico; teste conta prompt no argv) |
| `fix(missão)` kimi mudo + coroa apagada por CSS | **REAL** | `mission-completion-marker.ts` (novo, +33), `base.css` (+7) |
| `feat(missão)` CLI que não sobe vira motivo na hora | **REAL, com teste** | `pre-spawn-probe.ts` (+33) + `.test.ts` |
| `fix(missão)` encerrar é ordem, não renasce sozinha | **REAL** | `terminal-host.ts` (+19) |
| `fix(contas)` limite fantasma (cooldown vencido) | **REAL, com teste** | `account-cooldown.ts` (novo, +48) + `.test.ts` |
| `feat(spawn)` sem login: abre o pane e pede login lá dentro | **REAL** | `pty-manager.ts` (+125) |
| `fix(update)` ponte ausente não derruba o app | **REAL** | `UpdateModal.tsx` (+5) |
| `fix(missão)` entrega por saída sustentada + PRONTO como regra | **REAL** | `mission-fast-lane.ts` (+97) |

**O que sobreviveu a essa rodada (os que importam):**
- **B1 sobrevive** — `worker-handoff-enforcement.ts`, `orch-ipc.ts`, `mission-engine-production.ts`, `mission-store.ts` **não estão no diff**. O enforcement global segue incondicional.
- **B2 sobrevive** — a autoridade de direção segue gated no `orchestratorSessionId` null do fast-lane.
- **B4/B8 sobrevivem** — nenhum dos dois foi tocado.

**Outros itens verificados:**
- **Doutrina/playbook:** FECHADO. `mission-fast-lane.ts:153-155` agora usa `buildOrchestratorDoctrine(squad, mission)`. (Gap apontado no relatório de 10/08 — resolvido.)
- **Sessão PTY persistente (tmux):** flag `ptyPersistentSession` com `defaultEnabled:false` → **OFF confirmado**. Honesto: não está ativo.
- **Voz modo code:** commitado (`0a85bca1`) — não está mais "uncommitted" como constava no memory de 10/08.
- **Versão instalada na sua máquina:** é a **0.31.1**. Nenhum dos 9 commits está no seu app. Precisa de uma 0.31.2.

---

## 6. O que copiar (concreto, delta mínimo) — priorizado

| # | Cópia | De onde | Delta estimado | Por quê |
|---|---|---|---|---|
| **P0-1** | **Gate de lane no `worker-handoff-enforcement`**: se missão é fast-lane, não nudge nem faz handoff sintético — a conclusão é observacional | Overclock (não mexer no que já funciona) | **P** | Desliga o conflito que "quebra um lado quando conserta o outro" |
| **P0-2** | **Corrigir autoridade de direção no fast-lane**: permitir comando direto do operador sem exigir `orchestratorSessionId` no fast-lane | Overclock (`input-origin` + dedup por turno) | **P–M** | Deixa o operador mandar e ser obedecido no caminho rápido |
| **P1-1** | **Projeção em disco** (estado legível do fast-lane em arquivo, estilo Bridge) para diagnóstico sem abrir o app | Bridge (`bs-swarm`/`bs-mail`) | **M** | Elimina "invisível até o app abrir"; ataca B5 |
| **P1-2** | **Origem humano×sistema** (`input-origin` portado) para a entrega de pane | Overclock H9 | **P** | Evita acordar o chefe com conversa do operador |
| **P1-3** | **Fail-open no stop / desacoplado** para a entrega do fast-lane | Overclock H1+H10 | **M** | Fecha o furo de `0fe423aa` sem o risco que nos travou |
| **P1-4** | **`ownershipFiles` nos templates de wave-pack** | Overclock (declaração de forma) | **P** | É o que abre a tela em leque — socket já existe |
| **P2-1** | Ensino invisível por `UserPromptSubmit` (não erro visível na TUI) | Overclock H4 | **P** | Zero pixels, chega no turno certo |
| **P2-2** | Degradação gradual em vez de fail-closed nas pontas não críticas | Bridge | M | Resiliência de swarm |

> **Não copiar (observado ao vivo):** monocultura de CLI em squad; `width_cap`
> contando pane morto até recusar a própria recuperação; fantasmas de TTL que
> exigem purge+resume; avisos falsos de morte; ausência de `pane_list` para o
> próprio piloto.

---

## 7. Lacunas de verificação (honestidade)

1. **As 293 falhas do main** são plausivelmente ABI (better-sqlite3 compilado para Electron enquanto o dev está aberto) — mas **não provadas**. Provar exige fechar o app + `npm run rebuild:node`, o que **não** deve ser feito com o node_modules compartilhado por outra sessão (memory: `node-modules-compartilhado-concorrencia`).
2. **A frota de 12 não foi re-rodada com os 9 fixes dentro.** Testes verdes e causas provadas, mas não a prova ao vivo.
3. A 0.31.1 instalada **não contém** nada dos 9 commits — a prova ao vivo só existe depois de cortar a 0.31.2.

---

## 8. Decisões pendentes (suas)

- **B8 — modo governed:** o inventário oferece executor que a cerca de spawn depois recusa. Ou o inventário filtra pelo que o spawn aceita, ou o spawn passa a aceitar o executor oferecido. Precisa de decisão.
- **B4 — mensagens `[nexus]` repetidas:** limpeza de histórico por pane — comportamento esperado ou bug?

---

## 9. Verificação ao vivo — escopo "Expresso + runtime" (aprovado)

Execução em 11/08 no app dev (.dev-user-data, CDP 9223, Vite HMR ativo). O plano
aprovado (`graceful-sparking-mango`) teve as três partes implementadas e verificadas:

| Parte | Estado | Evidência |
|---|---|---|
| **P0-1** gate do `worker-handoff-enforcement` (flag default-OFF) | **VERIFICADO ao vivo** | Missão expressa completa por conclusão observacional: board "Concluída", `smoke-express.md` criado com `"smoke express ok"`, **zero** `NEXUS_HANDOFF_REQUIRED` no DOM e nos 4 panes (Coordenar/Execução/Execução/Revisão — todos "Concluído") |
| **P0-2** operador como orquestrador (`deliverMissionDirectInstruction`) | **VERIFICADO por 13 testes unitários**; prova B ao vivo **não produzível** pela UI atual (ver nota) | `mission-engine-production.test.ts` cobre os 4 cenários do plano: (a) squad sem orquestrador + worker vivo → aceito; (b) squad com orquestrador → comportamento preservado; (c) target fora da squad selada → rejeitado; (d) sem dispatch authority → rejeitado |
| **C** Caminho Expresso (1 tela "Descreva → Iniciar") | **VERIFICADO ao vivo** | Fix do roster (`readyWorkers` filtra workers sem modelo — cursor-agent não mata mais a equipe) provou o fluxo completo: express → equipe automática "4 papéis" sem erro → missão roda e entrega |

**Resultado da suíte:** 140/140 testes verdes (51 MissionSetup, 13 mission-engine-production,
25 mission-setup-store, feature-flags) + typecheck EXIT:0 (zero erros).

### Nota de honestidade — prova B (squad sem orquestrador) ao vivo

A prova B do plano exige um squad **selado sem orquestrador**. A UI atual não
consegue produzi-lo:
- Todas as lanes de `recommendMissionRosterRoles` (consult/plan/ops/standard)
  incluem `mission-coordinator` (categoria `orchestrator`);
- o wizard bloqueia a remoção do coordenador
  (`TeamStep.tsx:587 removable={agent.category !== 'orchestrator'}`);
- `freeAgentChoice` (modo livre) só bypassa 3 gates de **spawn**
  (`free-agent-choice.ts`), não remove o orquestrador do roster.

Ou seja: o branch `operatorIsOrchestrator`
(`mission-engine-production.ts:555`) hoje é **inalcançável pela UI normal** — a
missão expressa que rodou tinha orquestrador (lane standard). A cobertura é dos
13 testes unitários que montam squad sem orquestrador diretamente. O caminho
agêntico (intent-first, `mission-reopen.ts:26`) arma o shell **sem panes**, mas
o coordenador continua no contrato de intenção. Quando existir um caminho de UI
que monte squad selado só de executores, a prova B vira ao vivo automaticamente.

### Legado de ambiente
- Script de poll temporário `scripts/spikes/poll-mission.mjs` criado e removido
  (ESM não resolve `ws` fora da árvore do repo — rodar polls de dentro do repo).

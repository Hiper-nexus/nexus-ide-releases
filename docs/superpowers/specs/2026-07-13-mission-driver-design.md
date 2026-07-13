# Nexus Mission Driver — Loop de Missão Goal-Driven

**Data:** 2026-07-13
**Status:** design proposto — pronto para implementação incremental faseada (Fase A aditiva, zero efeito)
**Escopo:** runtime de orquestração, confiabilidade de missão, memória durável por missão
**Referência analisada:** [`snarktank/ralph@6c53cb0`](https://github.com/snarktank/ralph) — padrão Ralph (Geoffrey Huntley)
**Specs relacionados:** [`2026-07-10-nexus-context-verification-harness-design.md`](./2026-07-10-nexus-context-verification-harness-design.md)

## Decisão

O Nexus ganhará um **Mission Driver** nativo: um loop *goal-driven* que mantém uma
missão progredindo até `done` (ou até um limite de orçamento), composição dos
primitives maduros que já existem no `orch/` — **sem** importar `ralph.sh`.

O driver adotará os conceitos fortes do Ralph — outer loop "até terminar",
contexto fresco por iteração, memória durável (checkpoint + learnings) — **sem**
delegar ao Ralph autoridade sobre execução, stop-condition ou plataforma. O
Ralph será tratado como referência de pattern, não como dependência.

Isso fecha o único gap real que o Ralph expõe: o Nexus hoje é um *host +
containment shell* de agent-loops; o loop ReAct/tool-calling vive no CLI externo
spawnado num PTY. O único loop recorrente *ownership-do-Nexus* é o **cron tick**
(`src/main/orch/cron-runtime.ts:272`), que é *time-driven* e cria uma missão nova
a cada disparo (`fireCronJob`, `cron-runtime.ts:47`). Não existe hoje um loop
*goal-driven* que **continue uma missão** até sua conclusão. O Mission Driver é
esse loop.

## Problema real

- Uma missão pode parar de progredir por: CLI travado, pane morto, account
  exausto, stall silencioso, ou simplesmente o orchestrator declarar "terminei"
  sem ter fechado todos os critérios.
- Hoje a recuperação é parcial: o **stall-watchdog** sinaliza o orchestrator com
  um handoff sintético `stalled` (`stall-watchdog.ts:144`), o **failover**
  troca de account exaurida (`failover.ts`), o **stop-gate** impede saída sem
  handoff confiável (`gate.ts:318`, `MAX_STOP_ATTEMPTS=3`). Mas **nada compõe
  isso num ciclo auto-corretivo por missão** — nada decide "respawne com contexto
  fresco", "tente outra rota de agente", "espera mais", "declare bloqueio
  humano".
- Não há memória durável *por missão* de aprendizados entre iterações: o
  `ScopedMission.milestones` é `string[]` (`mission-store.ts:93`,
  `orch-types.ts:93`) — uma lista plana de rótulos, sem estado por etapa, sem
  análog
  *log de aprendizados*.
- O resultado é que "continue trabalhando até done" não tem dono no runtime do
  Nexus; essa responsabilidade cai inteira sobre o prompt do CLI externo.

## O que o Nexus já possui (reuso direto)

| Fundação | Situação | Reuso no driver |
| --- | --- | --- |
| Cron skeleton | `runCronTick(deps)` puro-no-tempo, `startCronLoop`/`stopCronLoop` idempotentes, `setInterval().unref()` (`cron-runtime.ts:212,272,282`) | molde exato do loop: tick puro + IO injetável + init/shutdown idempotente |
| Stall watchdog | `shouldFlagStall` decisão pura unit-testável; sinaliza via handoff sintético, **nunca mata** (`stall-watchdog.ts:41,144`) | modelo de "sinaliza, não destrói"; mesmo canal de handoff |
| Failover | detecta account exaurida e re-spawna com `--resume` | ação de recuperação de account dentro do drive |
| PREVC | `advanceWorkflow` exige evidence por fase (`prevc-engine.ts:290`); `done` só via advance, nunca auto-declarado | gate de conclusão da missão e de cada etapa |
| Stop-gate + trusted evidence | `evaluateStop`/`markHandoffSubmitted`; `nexus-trusted` evidence via `assertEvidenceMatches` (`gate.ts:318`, `handoff-store.ts`) | stop-condition verificável — **nunca** uma promise textual |
| ScopedMissionStore | CAS, scoped, `onChange` (`mission-store.ts:65`, `project-domain-store-registry.ts:23`) | estado da missão e checkpoint de etapas |
| Panes / respawn | `killLiveAgents` + spawn; `spawnPaneAndMaybePrompt` | fresh-context por iteração |
| Effect policy + CLI confinement | `mcp-effect-policy.ts` default-deny; `autonomous-cli-policy.secureAutonomousCliArgs` | toda ação do drive atravessa o mesmo gate fail-closed |
| Task router | `classifyTask` + routing table (`task-router.ts`) | escolha de rota/agente alternativo na recuperação |
| ProjectExecutionScope | projeto + checkout + instalação canônicos | chave obrigatória de todo drive (multi-PC/multi-projeto) |

## Lições do Ralph

### Preservar

- **Outer loop "até terminar"** como cidadão de primeira classe do runtime, não
  delegado ao prompt do CLI.
- **Fresh-context por iteração**: combater *context rot* re-spawneando com estado
  recarregado de fontes duráveis (git + checkpoint + learnings).
- **Trinca de memória durável**: checkpoint legível por máquina (`prd.json`
  `passes:boolean`) + log append-only de aprendizados com **seção de padrões no
  topo** + git como fonte de verdade.
- **Right-sizing e ordem por dependência** de etapas — embora o Nexus já resolva
  isso em outra camada (`task-router` + `squad-architect`), o driver deve
  respeitar os limites de "uma etapa = uma janela de contexto".

### Não portar

- **`ralph.sh` com `--dangerously-skip-permissions` / `amp --dangerously-allow-all`**:
  o Nexus já tem `mcp-effect-policy` + `autonomous-cli-policy` que *strippam*
  flags YOLO dos providers e aplicam modo seguro declarado. Importar seria
  desmontar o gate. **Regressão de segurança — rejeitado.**
- **`<promise>COMPLETE</promise>` como stop-condition**: gameável (o LLM pode
  emitir a promise para escapar do loop). O Nexus resolveu isso corretamente:
  `done` só via `advanceWorkflow` com evidence `nexus-trusted`, e a kickoff
  prompt já proíbe o orchestrator de declarar `done`. **Regressão de
  confiabilidade — rejeitado.**
- **Bash single-branch single-repo**: quebra no Windows e viola o requisito
  multi-PC/cross-OS (`nexus-multiplataforma`). **Rejeitado.**
- **Kill + retry cego em stall**: o watchdog é não-destrutivo por design — um
  build longo é silêncio legítimo (`stall-watchdog.ts:24-27`). Um loop ingênuo
  estilo Ralph mataria trabalho produtivo. **Rejeitado.**

## Invariantes não negociáveis

1. **Não-destrutivo em stall.** O drive nunca mata um worker silencioso. Ele
   sinaliza o orchestrator (mesmo canal do watchdog) e decide entre *esperar*,
   *diagnosticar* (ler o pane) ou, só após budget esgotado, *bloquear para
   humano*. Silêncio ≠ travamento.
2. **Stop só por evidence-trusted.** A conclusão da missão (e de cada etapa)
   atravessa `advanceWorkflow` + `nexus-trusted` evidence. O drive **nunca**
   aceita auto-declaração do agente nem token textual tipo promise.
3. **Fail-closed em effect.** Toda ação do drive (respawn, route, commit) passa
   por `dispatchToolCall` → `mcp-effect-policy` → `bindEffectAuthority`. Não há
   atalho "confiou uma vez, confia pelo loop".
4. **Puro em relação ao estado.** A função central do tick —
   `runMissionDrive(missionId, deps)` — é **pura em relação ao estado** (lê
   estado + injeta IO + recebe `now`), análog
   *runCronTick* é puro em relação ao tempo. Testável sem relógio nem processos.
5. **Orçamento finito + backoff + escape.** Nenhum drive corre indefinidamente:
   `maxIterations`, `maxWallClockMs`, backoff exponencial entre tentativas, e
   saída para `blocked` humano quando o budget se esgota. O loop do Ralph "roda
   para sempre por padrão" é explicitamente recusado.
6. **Scoped e CAS.** Todo drive é chaveado por `ProjectExecutionScope`
   (projectId/checkoutId/installationId) e persiste via stores CAS, como todo
   `project-domain-store`. Multi-PC e multi-projeto desde o nascimento.

## Design

### Princípio fundamental: puro-no-estado

O cron é puro-no-tempo: `runCronTick(deps)` recebe `now` e os jobs, decide o que
dispara, não depende de estado mutável global. O Mission Driver é **puro-no-estado**:
`runMissionDrive(missionId, deps)` recebe o estado atual da missão (etapas,
evidence, stalls, budget restante) e a hora, decide **uma** ação, e termina. O
efeito (respawn, handoff sintético, setStatus, append de learnings) é produzido
via `deps` injetáveis — nunca como side-effect oculto.

```
runMissionDrive(missionId, deps): DriveAction
  estado = deps.loadDrive(missionId)         // puro: lê store + evidence + watchdog flags
  decisao = decideDriveAction(estado, now)   // pura, unit-testável (como shouldFlagStall)
  return decisao                             // {kind, payload} — o caller aplica via deps
```

`decideDriveAction` é a função pura testável. Seus `kind`s:

| `DriveAction.kind` | Quando | Efeito (aplicado pelo caller) |
| --- | --- | --- |
| `wait` | progresso recente, budget ok, sem stall | nada; próximo tick |
| `signal-stall` | worker busy em silêncio ≥ limiar | handoff sintético `stalled` (canal do watchdog) |
| `respawn-fresh-context` | context rot / pane morto / budget de iteração restante | `killLiveAgents` + spawn com state recap carregado |
| `re-route` | account exaurida / adapter falhando | failover + task-router escolhe rota alternativa |
| `advance` | etapa com evidence `nexus-trusted` pronta | `advanceWorkflow` (PREVC) |
| `block-human` | budget esgotado / stall crônico / bloqueador não-técnico | `setStatus('blocked')` + aprendizado |
| `complete` | todas etapas `done` via PREVC | `setStatus('done')` — só aqui |

### `DriveDeps` (IO injetável)

```ts
interface DriveDeps {
  loadDrive(missionId: string, scope: ProjectExecutionScope): DriveState;
  applyAction(missionId: string, action: DriveAction, scope: ProjectExecutionScope): Promise<void>;
  submitStalledHandoff(...): Handoff;      // = onHandoffSubmitted path
  respawnFreshContext(missionId: string, recap: MissionRecap): Promise<void>;
  advanceWorkflow(...): Promise<AdvanceResult>;
  now(): number;
}
```

`defaultDriveDeps` usa os stores reais; testes injetam fakes. Mesmo molde de
`CronRuntimeDeps` (`cron-runtime.ts:37`).

### Artefato 1 — checkpoint de etapas (mission-state)

Hoje `milestones: string[]` não carrega estado. Duas opções, decidir na Fase B:

- **(a) Estender o schema do milestone** para `{id, label, status, evidenceIds[]}`
  dentro do `milestones_json` existente — sem migration de tabela, só evolução
  do parser (`mission-store.ts:53`). Aditivo, backward-compatível (string vira
  objeto com `status` default).
- **(b) Tabela nova `mission_steps`** com FK para `missions`, scoped e CAS.

**Recomendação senior:** **(a)** primeiro. Mantém o núcleo atômico, respeita o
fatiamento aditivo-primeiro. Ir para (b) só se a cardinalidade/consulta exigir.

`status` por etapa reusa o vocabulário PREVC (não o `passes:boolean` cru do
Ralph): `{pending, in-progress, blocked, done}`, com `done` exigindo
`evidenceIds` que resolvam para `nexus-trusted`.

### Artefato 2 — learnings log (análogo ao `progress.txt`)

Append-only, scoped por missão, com **seção `## Padrões` consolidada no topo**
(a ideia mais barata e mais esperta do Ralph — o distill onde o agente lê
primeiro). Implementação:

- **(a) Coluna `learnings_json`** na missão (texto markdown estruturado), ou
- **(b) Tabela `mission_learnings`** append-only com timestamp.

**Recomendação senior:** **(a)** na Fase A. O store já é CAS; um campo markdown
basta. O driver e o orchestrator leem a seção `## Padrões` ao montar o recap de
cada iteração — é o mecanismo de memória entre iterações de contexto-fresco.

### Init/shutdown

```
startMissionDriverLoop(deps = defaultDriveDeps)   // idempotente, setInterval().unref()
stopMissionDriverLoop()
```

Tick a cada `DRIVE_TICK_MS` (sugerido 30s — mesmo ritmo do watchdog). A cada tick,
itera missões `running` no scope ativo e chama `runMissionDrive`. O loop é
`.unref()`'d como o cron — não mantém o processo vivo.

### Composição (fluxo por tick)

```
para cada missão running no scope ativo:
  estado = loadDrive(missionId)
  ação   = decideDriveAction(estado, now)        // pura
  aplique ação via deps                          // fail-closed em effect
  registre aprendizado se houver decisão não-trivial
```

O drive **reage** a eventos que já existem: handoff `stalled` (watchdog), evento
de failover, transição de fase PREVC. Ele não re-imprime a detecção — consome o
que o watchdog/failover já produziram.

## Fatiamento (aditivos-primeiro, alinhado a `fase0-fatiamento-v012`)

| Fase | Entrega | Risco | Estado do loop |
| --- | --- | --- | --- |
| **A — Observabilidade + learnings** | `learnings_json` na missão; `decideDriveAction` puro (retorna só `wait`/`signal-stall`); drive em modo **shadow** (loga decisões, **não aplica** efeito) | zero efeito em produção; puramente aditivo | observa |
| **B — Checkpoint de etapas** | milestone estruturado (opção a); `loadDrive` lê etapas + evidence | migration aditiva de schema (parser) | observa |
| **C — Drive ativo** | drive aplica `DriveAction` via deps, com `maxIterations`/`maxWallClockMs`/backoff; não-destrutivo; stop só via `advanceWorkflow` | médio — behavior novo, mitigado por budget + invariantes | age |
| **D — Voice→mission (opcional)** | `WakeEngine.onDetected` (`wake-engine.ts:213`) pode disparar/retomar missão | fecha gap voz→missão; escopo isolado | age |

Cada fase é independente e shippable sozinha. A Fase A já entrega valor
(observabilidade de "por que a missão parou") sem tocar behavior de execução.

## Alternativas consideradas

- **Importar `ralph.sh`.** Rejeitado: `--dangerously-skip-permissions`,
  `<promise>` gameável, bash single-plataforma, kill+retry cego. Regride nos
  três invariantes onde o Nexus já está correto (sec, stop, multi-OS).
- **Plugin `ralph-loop` in-session (stop hook que realimenta o prompt).**
  Rejeitado: é *session-bound* (não sobrevive a crash do CLI, não serve
  multi-PC), herda a mesma armadilha do *promise* como stop-condition, e opera
  fora do gate/effect-policy do Nexus. Útil como demonstração do pattern, não
  como mecanismo de produção.
- **"Só usar o cron".** Não basta: o cron é *time-driven* e cria uma missão
  nova a cada disparo (`fireCronJob`). Ele não **continua** uma missão até sua
  conclusão, não consome evidence de etapa, não decide respawn com contexto
  fresco. É o skeleton, não o driver.

## Riscos e mitigações

| Risco | Mitigação |
| --- | --- |
| Drive entra em ciclo respawn→stall→respawn | `maxIterations` + backoff exponencial + escape para `blocked` humano (invariante 5) |
| Drive mata trabalho produtivo achando que é stall | não-destrutivo (invariante 1); silêncio legítimo respeitado como no watchdog |
| Falsa conclusão de etapa | stop só via `nexus-trusted` evidence + `advanceWorkflow` (invariante 2); nunca por promise |
| Concorrência entre drive e orchestrator humano | todo `applyAction` atravessa o gate; ações de efeito são auditadas e confirmáveis como hoje |
| Regression em multi-PC/CAS | chave por `ProjectExecutionScope`, stores CAS, `.unref()` (invariante 6) |
| Shadow mode na Fase A mascarar bug de decisão | `decideDriveAction` é função pura com testes unitários (mesmo molde de `shouldFlagStall`) antes de qualquer aplicação |

## Fora de escopo

- Substituir o loop ReAct interno do CLI externo — continua ownership do
  adapter. O drive age **sobre** o ciclo de vida da missão, não **dentro** do
  raciocínio do agente.
- Agendamento periódico *dentro* de uma missão (tipo "re-rode este sensor a cada
  5 min") — fica para o futuro; hoje sensores rodam on-demand nos estágios PREVC.
- Substituir o stop-gate ou a policy de effects — o drive é *consumidor* desses
  mecanismos, não substituto.

## Referências

- Padrão Ralph — [ghuntley.com/ralph](https://ghuntley.com/ralph/), [`snarktank/ralph`](https://github.com/snarktank/ralph)
- Skeleton de loop puro-no-tempo — `src/main/orch/cron-runtime.ts:212,272`
- Decisão pura + handoff sintético não-destrutivo — `src/main/orch/stall-watchdog.ts:41,144`
- Stop-condition verificável — `src/main/orch/gate.ts:318`, `MAX_STOP_ATTEMPTS=3`
- Scoped stores CAS — `src/main/orch/mission-store.ts:65`, `src/main/orch/project-domain-store-registry.ts:23`
- Spec irmão (mesma tese "conceitos sim, autoridade não") — [`2026-07-10-nexus-context-verification-harness-design.md`](./2026-07-10-nexus-context-verification-harness-design.md)

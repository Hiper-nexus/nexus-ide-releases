# Handoff — Nexus IDE · Via Rápida de Missão

Branch `claude/mission-projection-hardening-f08ee5` (contém todo o trabalho anterior de
`security/p0h1-mission-projection-hardening` via fast-forward).

---

## 1. O que mudou nesta sessão (2026-08-10)

### 1.1 Decisão de arquitetura: motor de execução novo (Via Rápida)

O pipeline cerimonial (plano selado → claim → kickoff ping-pong → receipts →
merge queue → autoridade de conclusão) foi **substituído como caminho padrão**
por um motor de ~600 linhas: [mission-fast-lane.ts](src/main/orch/mission-fast-lane.ts).

Modelo Overclock/BridgeMind:

1. `Iniciar missão` → **um terminal interativo por agente**, direto no
   workspace (`same_checkout`), com prompt curto de objetivo.
2. Agentes trabalham contínuo no próprio PTY — sem "uma ação por turno,
   processo morre, espera despacho" (o padrão antigo custava ~54s e 4.6k
   tokens POR AÇÃO do coordenador).
3. Conclusão **observada**: todo agente trabalhou (`busy`) e assentou
   (`idle`/saiu) ⇒ `done/done` via `MissionEngine.completeVerified`.
4. Pane que morre antes de trabalhar: respawn 1×. Prompt perdido no boot da
   TUI: nudge 1× após 90s. Silêncio total prolongado: bloqueio VISÍVEL com
   Retomar (nunca trava muda).
5. Retomada (`Retomar`/retry) **adota panes vivos** (nunca duplica — a família
   de auth exclusiva do claude recusa 2º coordenador) e religa os mortos.

O motor antigo continua atrás de `NEXUS_CEREMONIAL_MISSIONS=1` **até a
varredura de remoção** (seção 4).

### 1.2 Gates removidos (doutrina fluxo-por-padrão)

| Onde | Antes | Agora |
|---|---|---|
| [mission-runtime-readiness.ts](src/renderer/orch/mission-runtime-readiness.ts) | auth/modelo/conta reprovavam coordenador ("não está pronta") | instalada + não desligada = participa; capacidade ORDENA, não filtra |
| [TeamStep.tsx](src/renderer/components/mission/TeamStep.tsx) | loop de auth por agente bloqueava "Continuar" | só forma (schema, 1 coordenação) + ferramenta instalada; resto vira dica no cartão |
| [squad-runtime-policy.ts](src/main/orch/squad-runtime-policy.ts) `assessStandardSquadReadiness` | maestro-unavailable/claude-worker/executor-unavailable/reviewer-unavailable no approve | só `maestro-count` (exatamente 1) |
| [squad-runtime-inventory.ts](src/main/orch/squad-runtime-inventory.ts) | inventário escondia CLI sem rota/auth (`squad_missing`) | toda cli-pty instalada participa |
| [mission-snapshot.ts](src/main/orch/mission-snapshot.ts) | tripé autoridade+recibo+liveness projetava "Precisa de reparo" sobre missão viva | running É running (Via Rápida) |
| [mission-orchestrator-bootstrap.ts](src/main/orch/mission-orchestrator-bootstrap.ts) | reconciler/recovery cerimonial re-kickoffava por cima da equipe viva (kickoff-timeout eterno sem hooks) | varreduras desligadas sob Via Rápida; Retomar → `resumeFastLaneMission` |

### 1.3 Prova end-to-end (real, nesta máquina, build dev)

Missão: "Leia brief.txt e escreva a primeira frase em resumo.txt" em
`/tmp/autopilot-lab/proj`, equipe recomendada de 4 (claude coordenação, agy +
codex execução, revisor).

- Wizard 3 passos → Iniciar: **sem nenhuma reprova de readiness** (o cartão
  que dizia "Precisa de ajuste" agora diz "Pronto").
- 4 terminais interativos abriram; a equipe trabalhou; `resumo.txt` criado com
  o conteúdo exato **e commitado pela própria equipe** ("Create resumo.txt
  with first sentence of brief.txt").
- Missão fechou sozinha: `done/done` + result no banco.
- Kickoff aceito **sem os hooks de status** (o diálogo de primeiro boot que
  pedia para editar `~/.claude/settings.json` é desnecessário para missão).
- Duração ~5-6 min (maior parte = boot das CLIs), contra 32 min do gate
  cerimonial.

Segunda rodada ("Prova definitiva") no build com o pacote anti-briga validou:
projeção `running` limpa (sem "Precisa de reparo") — resultado final na seção 5.

---

## 2. Aprendizados operacionais da sessão

1. **Dois motores não podem disputar a mesma missão.** O reconciler antigo
   via "running sem recibo", re-kickoffava, estourava `kickoff-timeout` (a
   confirmação de turno dependia dos hooks recusados) e gravava blocked por
   cima da equipe viva. Qualquer motor novo precisa desligar as varreduras do
   velho.
2. **`workspace.open` programático é gate**: "workspace path was not
   authorized by the folder picker". O picker nativo funciona via
   Cmd+Shift+G (osascript). Relaxar depois para caminhos do usuário com
   auditoria.
3. O campo "Pasta do projeto" do wizard aceita digitação mas quem manda é o
   workspace ativo — digitar não troca. Ou vira read-only com botão, ou passa
   a trocar de verdade.
4. Preset "Enxuta 3" gera equipe sem revisor e a regra de forma exige revisor
   → beco. Ou o preset compõe com revisor, ou a exigência vira advisory.
5. Cartões do grafo mostram "Na fila" para agentes vivos da Via Rápida (o
   mapeamento de estado dos cards lê dispatches, que não existem mais).
   Cosmético; mapear estado do pane → card.
6. agy falhou spawn em caminhos de retomada mais de uma vez (histórico de
   keychain/TCC). O respawn 1× + equipe cobre, mas vale investigação própria.
7. Recents do rail aparecem de perfis anteriores mesmo com userData novo
   (fonte compartilhada — provavelmente `~/.nexus`). Inofensivo; auditar.

---

## 3. Como rodar

```bash
NEXUS_USER_DATA_DIR=.dev-user-data-autopilot NEXUS_REMOTE_DEBUG=9222 NEXUS_DEV_NO_VAULT=1 npm run start
```

- Motor antigo (se precisar comparar): `NEXUS_CEREMONIAL_MISSIONS=1`.
- Driver CDP do e2e ao vivo: scratchpad `cdp.mjs` (targets/eval/shot) +
  `pick-folder.applescript` para o picker nativo.

---

## 4. Varredura de remoção (próxima sessão) — código órfão do motor antigo

Com a Via Rápida como único caminho, perdem o último caller REAL (fora o env
de escape) e devem ser REMOVIDOS na varredura, com seus testes:

- `mission-orchestrator-bootstrap.ts`: `MissionOrchestratorBootstrapService`
  inteiro (bootstrap cerimonial, kickoff machine, recovery/reconciler,
  retirement) — mantém só: fábrica de ports do engine, `deliverMissionDirectInstruction`,
  projeção de snapshot, e os helpers que a Via Rápida usa.
- `mission-kickoff.ts` + `mission-kickoff-proof-ledger.ts` (o recibo pode
  virar interno da Via Rápida ou sair com a projeção simplificada).
- `guided-mission-planner.ts`, `mission-task-plan-authority.ts`,
  `guided-mission-prevc.ts`, `mission-freeze-authority.ts`,
  `guided-prevc-mcp-fence.ts`, `plan-promotion-authority.ts`,
  `promoted-plan-git-authority.ts`, `prevc-merge-preparation.ts`,
  `prevc-autopilot-coordinator.ts`.
- `mission-scheduler*.ts` (decide/runtime/production/dispatch-transaction/
  authority/guided-finalization), `task-dispatch-*.ts` (store/claim/lifecycle/
  handoff/quality-receipt/physical-git/physical-handoff/sealed-plan/
  mission-completion-authority), `merge-queue*.ts` + watchdogs.
- `mission-driver-*` (o observador da Via Rápida cumpre o papel; avaliar
  manter só stall-visibility).
- Shims de e2e no produto: `real-mission-e2e-*.ts` (main/preload) e o gate de
  45 min — trocar por um smoke da Via Rápida (abrir app → missão trivial →
  done < 5 min).
- `orchestration-coordinator.ts`: retirar participantes scheduler/driver.

Sequência sugerida: desconectar imports → `npm run typecheck` guia a poda →
apagar testes junto → rodar suíte de renderer + main restante.

## 5. Estado do e2e definitivo

(preencher com o resultado do vigia — `resumo.txt` + `done/done`)

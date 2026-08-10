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

## 4b. Reta final do release v0.30.0 (retomar AQUI)

Estado: varredura ~concluída (últimos lotes de testes órfãos), commits até
`40d35768` pushados. **O smoke pegou uma conclusão falsa (done sem artefato,
2/3 agentes mortos sem executar) e a regra foi corrigida (everyoneWorked =
every; morto-2x nunca assenta). O release SÓ sai com smoke verde.**

Sequência: (1) varredura entrega relatório → typecheck+suítes 100% →
(2) reiniciar dev → smoke no lab `/tmp/autopilot-lab/proj` (GUARD: conferir a
pasta no wizard — o app restaura o último workspace e o smoke já nasceu no
projeto real do operador uma vez) → `done` + `resumo.txt` corretos →
(3) push final → ff-push para `main` → tag anotada `v0.30.0` →
(4) do repo principal `/Users/cleofasrocha/dev/nexus-ide` (node_modules real):
`PATH=/opt/homebrew/opt/node@22/bin:$PATH NO_COLOR=1 npm run make:release`
(app dev PARADO) → verify por arch → `npm run release:publish` (gh logado,
notary `nexus-notary` validado). CHANGELOG 0.30.0 já escrito.

Diagnóstico pendente do smoke: por que agy e glm morrem no boot em panes de
missão (agy é reincidente; glm via claude-code binário saiu rápido). Ver
spawn args + [investigar como Overclock/Bridge entregam o primeiro prompt].

## 4a. BUG EM PRODUÇÃO 0.30.0 — dropdown de modelos com 2 itens (TODAS as CLIs)

Sintoma (print do operador): Modelo do cartão lista só 2 modelos (ex.: claude
sonnet-5/sonnet-4-5) em produção; em dev mostra 10. FATO APURADO: o
provider-config-store JÁ une estático+custom+descoberto (:895-905) — a raiz
NÃO é lá. Em algum ponto do caminho do wizard EM PRODUÇÃO o catálogo chega
FILTRADO POR AUTH (cache frio → poucos authReadyModels). Suspeito nº 1:
`squadRuntimeModelsForCli`/`authReadyModelsByCliId` reescrevendo
`adapter.models.list` na projeção que o renderer consome (squad-runtime-
inventory reescreve models dos adapters!). Conserto de doutrina Bridge:
CATÁLOGO NUNCA é filtrado por auth — auth no máximo rotula/ordena. Traçar no
perfil de PRODUÇÃO (não dev) qual IPC alimenta MissionSetup.inventory e
remover o scoping. Paliativo já em `bac295ee` (união na UI — só resolve se
uma das fontes chegar completa). Shipar como 0.30.1 (lembrar: versão em 5
lugares — package, server/package, lock server, CURRENT_RELEASE, CHANGELOG;
env trio do release; smoke obrigatório).

## 4c. Especificação visual do passo Equipe (referência BridgeMind — prints do operador 10/08)

1. **Launch mode** em cartões: SAFE (agentes pedem aprovação) × SKIP
   PERMISSIONS (bypass por CLI, só workspace confiável) — hoje o bypass é
   implícito; virar escolha visível.
2. **Chips de composição**: `1 Coordinator · 2 Builders · 1 Scout · 1
   Reviewer · All Claude · 5 total`, com dropdown de papel
   (BUILDER/SCOUT/REVIEWER/CUSTOM com descrição de uma linha).
3. **Catálogo de skills da equipe** (toggles por categoria WORKFLOW/QUALITY/
   OPS/ANALYSIS — Test-Driven, Code Review, Security Audit, Performance…):
   cada toggle injeta uma DIRETIVA no prompt dos agentes (expandível mostrando
   o texto). Mapear para `allowedSkills`/instructions já existentes.
4. Personalização inline por papel (JÁ FEITO em `40d35768`): Ferramenta,
   Modelo campo livre com datalist do catálogo da CLI, Esforço com escada
   universal de fallback. **Validar que o pane honra os três** (args de spawn
   por adapter: `--model`, flag de esforço) comparando com Overclock/Bridge.

## 5. Estado do e2e definitivo

- **Prova final (pequena)**: missão "ler brief.txt → escrever resumo.txt" pela
  UI: `done/done` + artefato exato em **~90 segundos**.
- **Simulação grande**: "Mini-site 11 stories", equipe **Força total (8 panes,
  6 providers** — claude, agy, codex×3, glm, kimi, grok): a equipe se
  auto-dividiu pelo STORIES.md (cada story marcada com o nome do agente) e
  entregou **10 páginas + style.css completos**. Três fantasmas do motor velho
  atacaram no caminho e foram desligados nesta sessão (exit-watcher do
  Maestro, seal de adoção do grid, mission-driver); a retomada pós-conserto
  volta a missão para `running` e o observador conclui.

### Achados da retomada da frota (medidos ao vivo, corrigir na próxima)
1. **Nudge não cobre `spawning`**: na retomada de 8 panes, as sessões novas
   ficaram presas em `spawning` (parsing de estado nunca flipou), a entrega
   inicial falhou e o nudge — que só dispara em `idle` — nunca re-entregou.
   Conserto: nudge também para `spawning` velho (>90s) e investigar por que o
   estado não flipa em pane headless respawnado.
2. **Cartões do grafo projetam panes VELHOS**: após retomada, os cards mostram
   "stopped" (linhas antigas de mission_panes) com 8 processos novos vivos —
   a projeção deve preferir a linha mais recente por agente.

### Pendência nº 1 da próxima sessão (visual, não motor)
Os panes da Via Rápida ainda **não são adotados pelo grid do renderer** — a
missão trabalha e conclui, o painel de Atividade/Fan-out mostra tudo ao vivo,
mas a vista "Terminais" exibe o empty-state ("nenhum pane foi aberto") no
lugar dos 8 terminais. O bypass de `canRestoreMissionPane` já existe; falta
descobrir qual sinal o view usa para montar o grid (provável: fluxo de adoção
via eventos que o spawn cerimonial emitia). É a única coisa entre o estado
atual e a experiência plena (ver terminal, digitar no agente, dar /comandos).
Segunda pendência: varredura de remoção da seção 4.

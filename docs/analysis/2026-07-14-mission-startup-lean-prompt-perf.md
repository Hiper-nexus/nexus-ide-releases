# Missão enxuta — análise sênior do startup de missão (prompt, UX, latência)

**Data:** 2026-07-14 · **Escopo:** intent-first mission runtime (ontem, 2026-07-13) — prompt de kickoff, prompts de worker, fluxo do wizard e latência percebida.

## Sintoma relatado

Missões curtas recebem um prompt grande e complexo demais — pior, não melhor. PREVC, convenções e o harness loop continuam necessários *às vezes*, mas o custo deles hoje é pago por toda missão, de qualquer tamanho. A experiência da UI ficou pesada e o startup, lento. Restrição: manter a orquestração dos CLIs e a qualidade.

## Diagnóstico (por evidência no código)

### 1. Duplicação no kickoff intent-first — o maior ofensor

`buildIntentDispatchKickoffPrompt` (`src/renderer/orch/mission-launcher.ts`) montava, para TODA missão recém-despachada:

- `## Objetivo` — o goal completo (até 16 KB);
- `## Critérios de aceite` — que, sem critérios explícitos, é o **próprio goal reencenado** (`Objetivo concluído conforme: <goal[0..200]>` sintetizado em `compileIntentContract`);
- `## Memória compacta da missão` — que num primeiro despacho (handoffs=[], milestones pendentes, learnings vazio) contém **apenas goal + critérios de novo**.

Ou seja: numa missão curta o objetivo aparecia até **3×** no mesmo prompt. A memória compacta só tem valor quando existe progresso durável (retomadas).

### 2. Cartas fixas de ~8 KB em todo worker

`withHandoffContract` (`src/main/orch/tool-util.ts`) anexava ENGINEERING_CHARTER (~2.7 KB) + DESIGN_CHARTER (~2.2 KB) + PONYTAIL_RULES (~3 KB) a **todo** worker, independente do papel e da tarefa:

- Scout de pesquisa (não escreve código) pagava TDD + diff-ladder + anti-AI-look.
- Worker de backend pagava a carta de design de UI.
- Reviewer pagava a escada de tamanho de diff, que fala com autores.

A própria DESIGN_CHARTER declara "Applies whenever your task produces or changes UI" — a condição existia no texto, mas não no injetor.

### 3. UX: duas telas + jargão interno para qualquer missão

- Fluxo mínimo: OBJETIVO → "Continuar" → PLANO → "Começar". Duas telas e dois cliques mesmo para risco `normal`, cujo contrato o próprio design define como "Clicking Start authorizes the bounded autopilot".
- O composer exibia `Fila da missão · exec=goal_compile:running · queued=0 · cancelled=0` — exatamente o vocabulário que a regra "FALE HUMANO" do kickoff proíbe o orquestrador de vazar.

### 4. Latência real

- `submitMissionIntent`/`compileIntentContract` são locais e sub-ms — a compilação do objetivo NÃO é o gargalo.
- No caminho legado, o paste do kickoff aguardava `orientation.ensure()` **sem timeout**: mapa frio em repo grande = orquestrador parado olhando o vazio, sendo que o prompt já tem fallback "mapa aquecendo" e o doctor recupera o mapa sob demanda.
- O restante do tempo é boot do CLI (`waitFirstIdle`, até 15 s) — inerente ao CLI, não ao Nexus.

## O que NÃO mudou (de propósito)

- **PREVC continua a autoridade** de planning/review/execution/validation/confirmation — a proporcionalidade já existe nele (risco `low` = rota de 2 estágios). Nenhum gate foi afrouxado.
- Missões `sensitive`/`destructive` continuam paradas em `awaiting_approval` com aprovação explícita.
- Handoffs continuam não-confiáveis; integração só via `nexus_merge_task`; worktrees e budgets intactos.
- Toggles `seniorMode`/`designPro`/`leanCode` continuam o gate externo — o tier só decide *dentro* deles.

## Mudanças aplicadas

| # | Mudança | Arquivos | Efeito |
|---|---------|----------|--------|
| 1 | Memória compacta só entra no kickoff quando tem progresso real (`missionCompactHasProgress`) | `shared/mission-context-compact.ts`, `MissionWizard.tsx` | −1 duplicação integral de goal+critérios no primeiro despacho |
| 2 | Critério auto-derivado (`Objetivo concluído conforme:`) filtrado do kickoff (`isAutoDerivedCriterion`) | `shared/mission-intent.ts`, `mission-launcher.ts` | goal aparece 1×, não 2–3× |
| 3 | Tier de cartas por papel/tarefa: scout/architect = nenhuma; reviewer = engenharia (sem ponytail); executor = engenharia+ponytail, design **só** com sinal de UI no brief/título/nome | `tool-util.ts`, `tools-panes.ts` | −~8 KB no scout, −~2.2 KB em tarefa não-UI; UI-task mantém tudo |
| 4 | Um clique para risco normal: "Começar missão" compila e despacha quando o contrato cai em `ready_to_start`; "Revisar plano" mantém o fluxo em duas etapas; aprovação sensível intacta | `MissionWizard.tsx` | missão curta = 1 tela, 1 clique |
| 5 | Hint da fila humanizado ("Processando o objetivo…", "1 pedido aguardando") e oculto quando ociosa | `MissionWizard.tsx` | zero jargão interno na UI |
| 6 | `orientationForKickoff`: paste do kickoff legado nunca espera o warm mais que 4 s (fallback "mapa aquecendo" já existia) | `mission-launcher.ts` | startup não trava em repo grande/frio |
| 7 | Proporcionalidade explícita no playbook: "missão pequena é UMA tarefa e UM especialista" | `mission-launcher.ts` | menos cerimônia do orquestrador em missão curta |

## Riscos e mitigação

- **Falso negativo do sinal de UI** (worker de UI sem a carta de design): regex generosa (superset do `UI_SIGNAL` do contract-compiler, PT+EN) e corpus inclui título do pane + nome do agente (ex.: "Frontend"). Falso positivo = status quo anterior (carta incluída).
- **Auto-despacho pular revisão**: só ocorre para `ready_to_start` (risco `normal`); o botão "Revisar plano" preserva a inspeção manual; broadcast de voz continua caindo na tela de plano.
- **Kickoff legado sem mapa**: comportamento coberto pelo branch de fallback já existente + doctor sob demanda; teste cobre timeout/erro/sucesso.

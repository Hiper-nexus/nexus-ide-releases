# Diagnóstico sênior — NexusIDE × Overclock (local) × Orca (repo)

**Data:** 2026-07-22 (fechamento com evidência real)  
**Repo:** `cleofasvolarehost/nexus-ide` @ **0.19.26** (`0e2396b`)  
**Método:** código Nexus + docs internas + **Overclock instalado no Mac** + **clone completo** [stablyai/orca](https://github.com/stablyai/orca)

---

## Veredito em uma frase

O Nexus **não falha por falta de features** — falha porque o cérebro da missão ainda é um **LLM no TUI** (prompt-hope), enquanto o motor main tem regras boas mas **não dispacha com autoridade**. A 0.19.26 removeu fricção (modal/PREVC/wizard); **não** fechou o golden path de orquestração.

---

## O que existe hoje (foto 0.19.26)

| Camada | Estado |
|---|---|
| Terminal / PTY / xterm | Sólido (muito colhido do Orca) |
| Gate MCP + skill-gate dual | Sólido (moat vs Overclock) |
| Autopilot sem modal (0.19.26) | Missão aprovada autoriza ações; destrutivo ainda confirma |
| PREVC aditivo (0.19.26) | Sem freeze executa; com freeze receipts valem; `done` sem freeze exige nota ≥40 |
| Wizard fluxo único | Objetivo + lançar; lanes em “Opções avançadas”; default sem restrições |
| Router de modelos | **Bug mecânico** diversidade (RC1–RC5) **ainda aberto** |
| RouteReservation no spawn | **Ainda não enforced** |
| Kickoff idle→busy | Parcial (0.19.23+); buracos → silêncio/`blocked` fraco |
| Idle-delivery / handoff | Correto no papel; falha vira fila quieta |
| Testes unitários | ~6.021 verdes — **não provam missão E2E** |
| Release GitHub | Código 0.19.26 no `main`; tag/DMG **v0.19.26** pode ainda estar pendente (latest visto: v0.19.25) |

**Superfície orch:** ~141 arquivos prod `src/main/orch` (~39k LOC) + dezenas de `nexus_*`.

---

## Por que nenhuma missão completa (cadeia real)

1. Wizard arma intenção — OK (0.19.26 simplificou)  
2. Approve dispara spawn do orquestrador — pode falhar session/hooks/login  
3. Kickoff paste no PTY — **pode não ser aceito** (sem idle→busy)  
4. LLM deveria: doctor → (freeze best-effort) → route → spawn  
5. Router **enviesa** codex/grok; spawn **não exige** reservation  
6. Workers handoff; delivery exige idle + prova — **fila morre quieta**  
7. Vários loops (driver, scheduler, supervisor, failover) **sem dono único**  
8. Risco novo 0.19.26: `done` com nota ≥40 **sem worker real** parece completo

---

## Causas-raiz (código + análises 15–18/07)

1. **RC1** — quality de fixture no catálogo pre-empta diversidade  
2. **RC2** — `matchSignals` substring (`cript` ⊂ `typescript`)  
3. **RC3** — `route_task` consultivo; `pane_spawn` aceita qualquer adapter  
4. **RC4** — modo agêntico ignora squad salvo (`agentic-fallback-*`)  
5. **RC5** — reviewer/contexto ainda enviesa em setups sem glm/longcat  
6. **Estrutural** — prompt-hope vs enforcement mecânico; supervisores fragmentados  

Arquivos: `task-router.ts`, `tools-panes.ts`, `squad-architect.ts`, `mission-launcher.ts`, `idle-delivery.ts`, `mission-drive.ts`.

---

## Overclock — estudo REAL no Mac (não só docs)

### Arquitetura observada

- **App:** `/Applications/Overclock.app` — Tauri (Rust UI) + sidecar Node  
- **Core:** `Contents/Resources/sidecar/dist/index.jsc` — **bytenode** (não copiar; não decompilar para reuso)  
- **Runtime usuário:** `~/.overclock-app/` (+ às vezes `nexus-ide/.overclock-app/`)  
- **Evidência salva:** `evidence/overclock-*` neste workspace  

### Mecanismos que importam (padrão, não código)

| Mecanismo | Evidência | Lição pro Nexus |
|---|---|---|
| **soft-status.mjs** | Normaliza hooks Claude/Codex/Gemini/Grok → `soft-waiting-{paneId}` | Idle/waiting **real** multi-CLI; portar padrão em `hooks-gen` |
| **Handoff-driven wait** | Prompt: spawn → write → **END TURN**; worker `handoff_submit` acorda piloto; **nunca poll** | Delivery por evento, não `pane_read` em loop |
| **pane_wait_idle ≤15s** | Só confirma boot; não espera resultado de worker | Kickoff proof ≠ wait eterno |
| **PILOT T1 delegateOnly** | Sem Read/Grep/Edit/Bash; só `chef_invoke` + tools de introspecção/browser | Orquestrador **não** é o executor; motor + chefes |
| **3 chefes fixos** | scout → builder → reviewer via `overclock_chef_invoke` + recipes `spine[]` | Topologia **imposta**, não markdown no kickoff |
| **Tools MCP (bytecode strings)** | `handoff_submit/list`, `pane_spawn/write/wait_*`, `chef_invoke`, `agent_invoke`, `mission_*`, `recipe_*`, `squad_*`, `clarify`, media… | Superfície parecida; Nexus tem moat em gate/PREVC |
| **Activation-first** | Duas portas; recipe “site” sem calibration gate | 0.19.26 wizard alinha; falta motor |
| **tmox meta** | `@ovc_pane`, `@ovc_mission`, `@ovc_agent` em sessão | Identidade de pane estável |

### O que Overclock ganha / perde

- **Ganha:** voz pronta, soft-status, topologia delegate-only, onboarding activation-first, handoff como relógio  
- **Perde:** sandbox/OS security, PREVC profundo, dual skill-gate (Nexus é mais sério no papel)

### Proibido

Copiar binário, sidecar, bytenode, prompts proprietários verbatim. Só **padrões** reimplementados no Nexus.

---

## Orca — repo achado, clonado, orchestration lida

| | |
|---|---|
| Repo | [https://github.com/stablyai/orca](https://github.com/stablyai/orca) MIT |
| Clone estudo | `/home/user/workspace/orca` |
| Pin Nexus | `143c36e566483006fe54fa2716b019ec00599752` |
| Provenance | `third_party/provenance/orca-143c36e.json` — **102 arquivos** already-in-tree |
| Núcleo lido | `src/main/runtime/orchestration/{coordinator,db,preamble,lifecycle-reconciliation,types,groups}.ts` |

### Modelo Orca (o que é / o que não é)

**É:** ADE multi-agente — worktrees, terminais, coordinator loop, mensagens tipadas (`worker_done`, `heartbeat`, `decision_gate`, `escalation`), preamble de dispatch, authority por `sender_pane_key`, skill CLI version-matched.

**Não é:** OS de missão PREVC/squad/jarvis do Nexus. Não “trazer o Orca” sozinho fecha piloto automático de missão.

### Mecanismos a colher (MIT + attribution)

| Peça Orca | Comportamento | Uso no Nexus |
|---|---|---|
| `Coordinator.tick` | processMessages → escalations → gates → stale warn → dispatchReady → convergence | Um reconciler, decisões atômicas |
| `buildDispatchPreamble` | worker_done obrigatório, heartbeat 5min, **proíbe AskUserQuestion** (usa `orchestration ask`) | Workers não travam em TUI local |
| `reconcileLifecycleMessage` | worker_done/heartbeat só do **assignee pane** | Anti handoff/heartbeat falso |
| Task statuses | pending→ready→dispatched→completed/failed/blocked | Alinhar fila única |
| Dispatch stale | warn 10min, **não** auto-fail cego | Hung worker observável |
| Decompose | tasks pré-criadas (AI decompose futuro) | MissionPlan no main **antes** do LLM “inventar” |

### Não fazer com Orca

- Importar app mobile RN (decisão travada → thin client LAN/QR depois)  
- Achar que parity de UI = orquestração de missão  

---

## O que a 0.19.26 mudou (Kimi, sessão paralela)

Commit `0e2396b` — **Piloto Automático sem Modal**:

1. `mcp-dispatch.ts` — missão aprovada = skip confirm; `isDestructiveEffect` mantém modal  
2. PREVC — sem contrato = autoridade permissiva (protege só `.context/`)  
3. `tools-domain` — `done` sem freeze com nota ≥40 em qualquer lane  
4. Wizard — lanes em avançadas; default standard  
5. Kickoff copy — freeze/bootstrap best-effort  

**Isso ajuda vibe coder. Não fecha RC1–RC5 nem RouteReservation nem DoD E2E.**

---

## Norte (ordem fixa)

| Onda | Meta | Saída |
|---|---|---|
| **0** | Golden path mecânico | RouteReservation + diversity + kickoff proof + 1 missão done/blocked |
| **1** | Reconciler único + soft-status | Padrão Orca coordinator + Overclock soft-status |
| **2** | UX vibe + squad editor + Impeccable no pipeline | Produto dia a dia |
| **3** | Voz/clarify/SSH gerenciado | Superar Overclock sem copiar segurança fraca |
| **4** | Main authority; mobile LAN; Win/Linux | Plataforma |

---

## Entregáveis para o founder

1. **`BRIEFING-SOL-FABLE5-O-QUE-CODAR.md`** — o que falar + o que codar  
2. **`PROMPT-GPT-SOL-NEXUS-ORQUESTRACAO.md`** — prompt colável completo  
3. **`evidence/overclock-*`** — artefatos do runtime local  

---

## Recomendação imediata

1. **Uma** sessão Sol só com Onda 0 — pare sessões paralelas em orch  
2. Não desfazer 0.19.26  
3. Release/DMG 0.19.26 é ops separado; Sol não precisa notarizar  
4. Aceite: *“O Nexus só avança de versão quando uma missão real completa.”*

---

## Fontes

**Internas Nexus:**  
`docs/analysis/2026-07-15-analise-senior-orquestracao-overclock-orca.md`  
`docs/analysis/2026-07-18-analise-senior-nexus-vs-overclock-orca-omp.md`  
`docs/analysis/2026-07-13-overclock-harness-mcp-jarvis-senior-audit.md`  
`docs/analysis/2026-07-10-nexus-orca-integration-map.md`  
`CHANGELOG.md` 0.19.14–0.19.26  

**Overclock local:** `/Applications/Overclock.app`, `~/.overclock-app/*`  

**Orca:** https://github.com/stablyai/orca · pin `143c36e` · clone + `orchestration/*`  

**Código âncora:** `task-router.ts`, `tools-panes.ts`, `idle-delivery.ts`, `mission-drive.ts`, `mission-launcher.ts`, `mcp-dispatch.ts`, `mission-intent.ts`, `gate.ts`

# Plano mestre — grok-build + x-algorithm → Nexus

Data: 2026-07-18  
Fontes: [xai-org/grok-build](https://github.com/xai-org/grok-build) · [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm)  
Licenças: Apache-2.0 (inspiração / reimplementação; sem fork monorepo)

**Regra:** Nexus continua **cockpit multi-CLI**. Não viramos Grok Build nem feed do X.  
Transplantamos **órgãos e padrões**.

---

## 0. Mapa de valor

| Prioridade | Origem | Entrega | Status |
|------------|--------|---------|--------|
| **F1** | x-algorithm | RoutePipeline multi-score + diversity attenuation | **implementar agora** |
| **F1** | x-algorithm / grok | Circuit breaker por adapter | **implementar agora** |
| **F1** | x-algorithm Thunder | Hot cache leve (adapter snapshot) | **implementar agora** |
| **F2** | grok-build | CoW / fast worktrees (APFS clonefile) | planejado |
| **F2** | grok-build | Hunk tracker (agent vs humano) | planejado |
| **F2** | grok-build | Tool sandbox Seatbelt/Landlock | planejado |
| **F3** | grok-build | Plan mode UX (approve/revise) | planejado |
| **F3** | grok-build | Background tasks MCP (run/wait/kill) | planejado |
| **F3** | grok-build | Compaction engine multi-session | planejado |
| **F4** | grok-build | Codebase graph (tree-sitter) | planejado |
| **F4** | grok-build | Adapter `grok` CLI / ACP | planejado |
| **F4** | x-algorithm | Phoenix ML ranker treinado | **fora** (sem corpus) |

---

## 1. Fase 1 — Ranking brain (x-algorithm) — AGORA

### 1.1 Candidate pipeline mental model

```
Source (adapters) → Hydrate (catalog/auth) → Filter (installed/circuit)
  → Score (cost, quality, diversity, omp, circuit) → Select top-1 + alts
  → SideEffect (route_log)
```

### 1.2 Multi-action score (puro, isolado por candidato)

```
score = tableRankBonus
      + qualityScore
      - costPenalty
      - diversityPenalty * timesUsedInMission
      + ompPreferBoost
      - circuitOpenPenalty (∞ se open)
```

Candidate isolation: score(A) não depende do set de concorrentes no batch — diversity usa só *histórico da missão*.

### 1.3 Circuit breaker

- Estados: closed → open → half-open → closed  
- Chave: `adapterId` (depois: `adapterId:accountId`)  
- `recordFailure` / `recordSuccess`  
- Router filtra ou rebaixa open

### 1.4 Hot cache (Thunder-lite)

- Snapshot de adapters instalados com TTL curto  
- Invalidação em `adapter:changed`  
- Evita re-probe em todo `route_task`

### Critério F1

- `routeTask` comportamento preservado nos testes existentes + novos de multi-score  
- Circuit open nunca escolhido se houver alternativa  
- Documentado em `docs/orchestration.md`

---

## 2. Fase 2 — Isolation & safety (grok-build)

### 2.1 CoW worktrees

- macOS: `clonefile` / reflink-copy; fallback `git worktree`  
- API: create / reclaim / pool  
- Wire: `worktree-runtime-registry`

### 2.2 Hunk tracker

- Diff hunks com `source: agent|user|external`  
- UI: DiffAnnotate + MissionRail badge  
- Casa com hashline vendored

### 2.3 Sandbox de tools

- Perfis: workspace-only / workspace+net / yolo  
- Seatbelt (macOS) / Landlock (Linux) no spawn de shells headless  
- Não relaxar Electron sandbox do app

### Critério F2

- Squad de 3 workers em worktree CoW < N ms no APFS  
- Diff mostra “omp / codex / você”  
- Shell tool nega path fora do workspace no perfil default

---

## 3. Fase 3 — Operator UX (grok-build)

### 3.1 Plan mode

- Lane `plan`: writes só em `plan.md` da missão  
- UI approve / revise / quit  
- Gate tools de escrita fail-closed

### 3.2 Background tasks MCP

- `nexus_bg_run` / `nexus_bg_wait` / `nexus_bg_kill`  
- Notificações AgentNotifications  
- Dev server + testes longos sem bloquear turno

### 3.3 Compaction

- Política compartilhada para handoffs/kickoff longos  
- Inspirado em `xai-grok-compaction` (não o modelo Phoenix)

---

## 4. Fase 4 — Scale

- Codebase graph incremental (tree-sitter) → tools de navegação  
- Adapter `grok` se binário estável no PATH  
- Ranker offline só com dados históricos reais de missões

---

## 5. Ordem de PRs

| PR | Escopo |
|----|--------|
| **PR-A** | Plan doc + route multi-score + circuit breaker + wire tests |
| **PR-B** | CoW worktree macOS + fallback |
| **PR-C** | Hunk tracker + UI |
| **PR-D** | Sandbox seatbelt profiles |
| **PR-E** | Plan mode + bg MCP |

---

## 6. Fora de escopo

- Fork monorepo Rust no dmg  
- Phoenix training / ads blender / Kafka Thunder  
- Substituir multi-CLI por um único agent Grok  

---

## 7. Implementação nesta entrega

Fase 1 (PR-A): código + testes + docs orchestration.

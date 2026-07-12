# Nexus LLM Benchmark & Ranking — Análise Sênior

**Data:** 2026-07-11  
**Status:** análise de arquitetura (pré-implementação)  
**Prioridade:** crítica — base para routing inteligente por capacidade real  
**Escopo:** benchmark próprio, ranking por dimensão, feed do `task-router` e do catálogo

---

## 1. Sumário executivo

O Nexus **já tem o consumidor** de ranking de modelos. O que **não existe** é o **produtor** confiável de scores.

| Peça | Estado | Onde |
| --- | --- | --- |
| Schema `ModelQualityEvaluation` | Pronto | `src/shared/adapter-types.ts` |
| Validação `quality` no catálogo | Pronta (`overall` 0–100, `source: nexus-eval/...`) | `src/main/adapters/model-catalog.ts` |
| Roteamento por qualidade × custo | Pronto (só ativa se `quality` existir) | `src/main/orch/task-router.ts` → `evaluatedCandidates` |
| Dimensões: coding / reasoning / frontend / security | Pronto no schema + no router | idem |
| Catálogo publicado com scores | **Vazio** — só `costTier` / `availability` | `resources/model-catalog.json` |
| Harness de avaliação reprodutível | **Ausente** | — |
| UI de ranking / leaderboard LLM | **Ausente** | — |
| Pipeline CI / nightly de re-eval | **Ausente** | — |

**Conclusão:** construir o benchmark **não** é “mais uma feature solta”. É o **motor de verdade** que falta para o `DEFAULT_ROUTING_TABLE` deixar de ser opinião de engenheiro e virar política baseada em evidência.

Sem isso, o router:

1. usa tabela hand-curated (custo + intuição), e  
2. só promove modelos por qualidade **quando** alguém preencher `quality` manualmente — o que quase ninguém fará de forma reprodutível.

---

## 2. O que o código já espera (contrato implícito)

### 2.1 Schema canônico

```ts
interface ModelQualityEvaluation {
  overall: number;      // 0..100 obrigatório
  coding?: number;
  reasoning?: number;
  frontend?: number;
  security?: number;
  evaluatedAt: string;  // ISO date parseável
  source: string;       // /^nexus-eval\/[A-Za-z0-9._/-]{1,120}$/
}
```

O regex de `source` é deliberado: **só scores assinados como `nexus-eval/...` entram no catálogo**. Isso impede “números inventados no ChatGPT” de poluir o routing.

### 2.2 Router já escolhe por dimensão

`qualityDimension(taskText, tier)`:

| Sinais da tarefa | Dimensão |
| --- | --- |
| frontend, UI, CSS, design, responsive… | `frontend` |
| security, auth, payment, billing… | `security` |
| hard / critical sem sinal acima | `reasoning` |
| demais | `coding` |

Score efetivo:

```text
score = quality[dimension] ?? quality.coding ?? quality.overall
      - costPenalty(tier, costTier)
```

Penalidade de custo:

| Tier | Multiplicador de `modelRoutingRank` |
| --- | ---: |
| trivial / easy | ×12 (prefere barato) |
| medium | ×4 |
| hard / critical | ×0 (qualidade manda) |

**Implicação de produto:** o ranking **não** é um score único global. É um **vetor por competência**, com política de custo por tier. O benchmark deve produzir exatamente esse vetor.

### 2.3 Fallback atual

Se nenhum modelo instalado tiver `quality` válido → ranking por `DEFAULT_ROUTING_TABLE` (ladder barato→caro por tier). Isso continua válido como **baseline de segurança operacional**, nunca como “verdade de qualidade”.

---

## 3. Problema real (por que leaderboards públicos não bastam)

Leaderboards genéricos (LMSYS, SWE-bench, LiveCodeBench, Aider, etc.) falham para o Nexus por:

1. **Superfície errada** — Nexus roda **CLI agents com MCP, PTY, worktrees, review council**, não chat bare.
2. **Adapter ≠ model** — `claude-sonnet-5` via Claude CLI ≠ mesma UX/custo/rate-limit que API; GLM/LongCat reusam binário Claude com endpoint/key diferentes.
3. **Tarefa multi-agente** — executor + reviewer independente + sensores; qualidade do *sistema* ≠ qualidade do one-shot.
4. **Custo e failover** — um modelo “melhor” que estoura quota em 10 min é pior no routing real.
5. **Drift** — providers mudam pesos sem mudar o id; score sem `evaluatedAt` + suite version é mentira.

O benchmark Nexus deve medir **o agente no ambiente Nexus**, não o modelo num playground.

---

## 4. Princípios de design (não negociáveis)

1. **Evidência > opinião** — score só entra no catálogo com run id, suite hash, timestamps e artefatos.
2. **Reprodutibilidade** — mesmo suite commit + mesmos prompts + temperatura/effort fixos → comparável; anotar `adapterId@version`, `modelId`, `effort`, OS.
3. **Dimensões alinhadas ao router** — coding, reasoning, frontend, security (+ overall composto). Não inventar 20 eixos no v1.
4. **Isolamento** — cada run em worktree/dir temporário; nunca no working tree sujo do usuário.
5. **Autor ≠ juiz** — o modelo sob teste **não** se auto-nota; scoring automático (tests/lint/diff oracle) + opcional reviewer cruzado de outro provider.
6. **Custo e latência são métricas de first-class**, não notas de rodapé.
7. **Fail closed no catálogo** — score inválido é descartado (já implementado em `safeModels`).
8. **Sem `force` de marketing** — ranking publicável só de suites versionadas; “vibe scores” ficam em overlay local opcional, nunca no published catalog.
9. **PII/secrets** — fixtures sem chaves reais; logs redigidos antes de persistir.
10. **Incremental** — v1 offline CLI + JSON; UI e nightly depois.

---

## 5. Arquitetura alvo

```text
┌─────────────────────────────────────────────────────────────┐
│  Nexus Eval Control Plane                                   │
│  (CLI: nexus-eval / script main-process)                    │
├─────────────────────────────────────────────────────────────┤
│  Suite Registry          Run Orchestrator                   │
│  - cases/*.yaml          - spawn adapter+model+effort       │
│  - oracles (test/diff)   - timeout, retry policy            │
│  - dimensions tags       - worktree isolation               │
│                          - cost + latency probes            │
├──────────────┬──────────────────────────┬───────────────────┤
│  Scorer      │  Aggregate / Ranker      │  Publishers       │
│  - pass rate │  - per-dimension 0..100  │  - model-catalog  │
│  - quality   │  - overall weights       │    .quality       │
│  - cost/lat  │  - confidence / n        │  - ranking JSON   │
│  - safety    │  - recency decay         │  - UI dashboard   │
└──────────────┴──────────────────────────┴───────────────────┘
                              │
                              ▼
                 resources/model-catalog.json
                 ~/.nexus/model-catalog.json (overlay)
                              │
                              ▼
                      task-router.evaluatedCandidates
```

### 5.1 Componentes

| Componente | Responsabilidade | Reuso Nexus |
| --- | --- | --- |
| **Suite Registry** | Casos versionados por dimensão | patterns de fixtures de testes; harness context |
| **Run Orchestrator** | Dispara cada `(adapter, model, effort, case)` isolado | `spawnPaneAndMaybePrompt`, worktrees, process sandbox |
| **Oracles** | Decidem pass/fail sem LLM quando possível | vitest, `contract-compiler` sensors, git diff |
| **Cross-reviewer** | Só quando oracle fraco (UX copy, design smell) | `cli-automated-reviewer` (provider ≠ author) |
| **Telemetry** | tokens, USD, wall time, rate-limit hits | `cost-tracker` / pricing |
| **Ranker** | Agrega → `ModelQualityEvaluation` | pure TS, unit-testable |
| **Catalog Publisher** | Escreve `quality` com `source: nexus-eval/<suite>@<sha>` | `model-catalog` merge/write |
| **Ranking Store** | Histórico de runs para UI/trend | JSONL sob `~/.nexus/eval/` ou repo `eval/results/` |

### 5.2 Identidade de um run

```text
EvalRunId = hash(
  suiteId, suiteCommit, caseId,
  adapterId, modelId, effort,
  nexusVersion, os, startedAt
)
```

Artefatos mínimos por case:

- prompt/input snapshot  
- output diff / files touched  
- oracle results (JSON)  
- cost + duration  
- exit status / timeout / rate-limit  
- optional reviewer report binding  

---

## 6. Suites v1 (o que medir de verdade)

Menos casos, mais signal. **Meta v1:** ~20–40 cases, 4 dimensões.

### 6.1 Coding (peso alto no overall)

| Case | Oracle |
| --- | --- |
| Fix failing unit test (1 arquivo) | `vitest` / `npm test` green |
| Implement small pure function from spec | golden tests |
| Multi-file refactor rename API | typecheck + tests |
| Bug hunt with stack trace | test + no unrelated files |
| Agent tool use: edit via MCP / file tools | file hash oracle |

### 6.2 Reasoning

| Case | Oracle |
| --- | --- |
| Trace logic bug across 3 modules | test |
| Design minimal algorithm (constraints) | property tests |
| Diagnose flake / race description | structured answer rubric *or* minimal repro test |
| Plan-only task (no code) scored by checklist | deterministic checklist scorer |

### 6.3 Frontend

| Case | Oracle |
| --- | --- |
| CSS/layout fix from screenshot description | snapshot / playwright assert |
| A11y: label/button roles | axe or simple DOM checks |
| Responsive tweak | viewport assertions |
| Component state bug | component test |

### 6.4 Security

| Case | Oracle |
| --- | --- |
| Find SQLi / XSS in fixture app | must cite line + fixed patch tests |
| Secret leak in diff — refuse or redact | policy scorer |
| Authz missing check | security test suite |
| Dangerous command proposal | must refuse / require confirmation pattern |

### 6.5 Fora de v1 (explicitamente)

- Multimodal vision leaderboard  
- Long-horizon multi-hour missions  
- Human preference Elo massivo  
- Treino de modelo  

---

## 7. Scoring math (proposta concreta)

Por case \(i\) no dimension \(d\):

\[
s_i = 100 \cdot \big( w_p \cdot pass_i + w_q \cdot quality_i - w_c \cdot costNorm_i - w_t \cdot timeNorm_i - w_r \cdot risk_i \big)
\]

Pesos iniciais (ajustáveis, versionados na suite):

| Termo | Peso | Notas |
| --- | ---: | --- |
| pass (oracle) | 0.55 | binário ou partial credit 0–1 |
| quality extras | 0.20 | diff size, no thrash, style checks |
| cost | 0.15 | USD normalizado no case |
| time | 0.05 | wall clock normalizado |
| risk | 0.05 | secrets, scope escape, force attempts |

Agregação por dimensão:

\[
score_d = \mathrm{clip}_{0..100}\big(\mathrm{mean}(s_i) \cdot confidence(n)\big)
\]

onde \(confidence(n) = \min(1, n / n_{min})\), \(n_{min}=5\) cases na dimensão.

**Overall:**

```text
overall = 0.40*coding + 0.25*reasoning + 0.15*frontend + 0.20*security
```

(Weights suite-versioned; documentados no `source`.)

**Recency:** ao publicar no catálogo, se `evaluatedAt` > 45 dias, UI marca stale; router v1 ainda usa, v2 pode decay.

---

## 8. Ranking product (como o usuário usa)

### 8.1 Views

1. **Leaderboard global** — overall + sparkline de tendência  
2. **Por dimensão** — “melhor para security”  
3. **Por tier de custo** — Pareto quality×$  
4. **Por adapter instalado** — só o que o user tem auth  
5. **Recommendation card** — “para esta tarefa o router usaria X porque…”

### 8.2 Integração operacional (o valor real)

| Consumidor | Uso do ranking |
| --- | --- |
| `task-router` | já implementado via `quality` |
| Review Council | preferir reviewers fortes em `security`/`reasoning` |
| Mission launcher | default model suggestion |
| Failover | próximo candidato por score, não só por lista fixa |
| Settings UI | mostrar medalhas / warnings stale |

### 8.3 Formato de publicação

```json
{
  "id": "glm-5.2",
  "availability": "cheap",
  "costTier": "low",
  "quality": {
    "overall": 78,
    "coding": 82,
    "reasoning": 74,
    "frontend": 70,
    "security": 71,
    "evaluatedAt": "2026-07-11T18:00:00.000Z",
    "source": "nexus-eval/v1@a1b2c3d"
  }
}
```

`source` deve apontar para suite+commit, nunca para “manual”.

---

## 9. Onde encaixa no monólito (paths sugeridos)

```text
src/main/eval/
  suite-types.ts
  suite-loader.ts
  run-orchestrator.ts
  scorers/
    oracle-test.ts
    oracle-diff.ts
    oracle-security.ts
  ranker.ts
  catalog-publisher.ts
  eval-ipc.ts                 # opcional, UI local

eval/
  suites/v1/
    coding/*.yaml
    reasoning/*.yaml
    frontend/*.yaml
    security/*.yaml
    suite.manifest.json
  fixtures/                   # mini repos
  results/.gitkeep            # local; CI artifacts uploaded

resources/model-catalog.json  # quality preenchido por publisher
docs/analysis/...             # este doc
```

**Não** misturar com voice benchmark (`docs/analysis/local-voice-benchmark-*`) — domínio diferente.

---

## 10. Risgos e mitigações

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Contaminação de suite (overfit) | Ranking inútil | rotacionar cases; holdout set; versionar suites |
| Juiz LLM enviesado | auto-promoção de famílias | oracles determinísticos prioritários; reviewer cross-vendor |
| Custo de re-eval full matrix | $ alto | sample models; stratified nightly; cache por model hash |
| Rate limits no meio do run | scores incompletos | partial runs + confidence; não publicar se n < n_min |
| Flaky tests no fixture | ruído | retries controlados; quarantine de cases |
| Worktree no repo sujo do user | perda de dados | sempre dir temp / worktree dedicado |
| Provider muda modelo sem id | stale win | recency UI + re-eval schedule |
| Security suite fraca | falsa confiança | cases com fix tests, não só “o modelo disse” |
| Gaming via custom catalog local | ok se local | published path CI-signed only |

---

## 11. Fases de entrega (PR plan realista)

### PR1 — Foundation (sem UI)
- Tipos `EvalSuite`, `EvalCase`, `EvalRun`, `EvalResult`
- Loader + manifest v1 com 5–8 cases coding
- Orchestrator dry-run (mock adapter) + unit tests
- Ranker pure functions + golden fixtures

### PR2 — Real runners
- Integração spawn CLI real (1–2 adapters: codex/grok)
- Worktree isolation + timeout
- Cost/latency capture
- Resultados JSONL em `~/.nexus/eval/runs/`

### PR3 — Suites completas v1
- 4 dimensões com n_min cases
- Security + frontend fixtures
- Cross-reviewer opcional reutilizando automated reviewer

### PR4 — Catalog publisher
- Gera `quality` blocks
- CLI: `nexus-eval publish --suite v1 --out resources/model-catalog.json`
- Testes de schema `nexus-eval/...`
- Atualiza published catalog com primeira rodada real

### PR5 — Routing validation
- Testes de integração: com quality filled, router escolhe top dimensional
- Documenta diferença vs `DEFAULT_ROUTING_TABLE`
- Telemetria “why this model” no reason string (já parcialmente existe)

### PR6 — UI ranking
- Settings / Orch panel: leaderboard, filters, stale badge
- Export CSV/JSON
- “Re-run eval for installed models” action

### PR7 — Nightly / ops
- GitHub Action opcional (secrets de providers)
- Artifact retention
- Drift alert quando overall muda > limiar

---

## 12. Key Decisions (recomendadas)

| # | Decisão | Rationale |
| --- | --- | --- |
| D1 | Produzir scores no formato `ModelQualityEvaluation` existente | Zero refactor no router; valor imediato |
| D2 | Oracles determinísticos > juiz LLM no v1 | Reprodutibilidade e anti-viés |
| D3 | Suite versionada no repo (`eval/suites`) | Auditoria, PR review de cases |
| D4 | Worktree/temp isolation obrigatória | Não corromper projetos do user |
| D5 | Confidence gate (`n_min`) antes de publicar | Evita ranking com 1 case sortudo |
| D6 | Manter `DEFAULT_ROUTING_TABLE` como fallback | Instalações sem scores continuam úteis |
| D7 | Overall composto com pesos fixos versionados | Transparência; evita black-box Elo cedo |
| D8 | Ranking UI depois do publisher | Dados verdadeiros antes de dashboard bonito |
| D9 | Cross-vendor reviewer só em cases ambíguos | Custo controlado |
| D10 | `source` sempre `nexus-eval/<suite>@<sha>` | Contrato já enforced em `safeModels` |

---

## 13. Anti-padrões (não fazer)

1. **Scraping LMSYS e colar no catálogo** — superfície errada; quebra o contrato `nexus-eval/`.  
2. **Um único score 0–100 genérico** — o router já é multi-dimensional.  
3. **Deixar o modelo se auto-avaliar** — contamina security e coding.  
4. **Benchmark só de chat Q&A** — Nexus é agentic (tools, files, git).  
5. **Publicar scores com n=1** — vira roleta.  
6. **Substituir a routing table manual cedo demais** — quality ainda rala → fallback necessário.  
7. **Misturar voice benchmark com LLM agent benchmark** — métricas e harness diferentes.

---

## 14. Critérios de sucesso (definição de “pronto”)

**MVP (PR1–PR4):**

- [ ] Rodar suite coding v1 em ≥3 modelos instalados  
- [ ] Gerar `quality` válido no catálogo local  
- [ ] `routeTask` loga `selecionado por avaliação Nexus por dimensão` com dados reais  
- [ ] Ranker unit-tested com fixtures estáveis  
- [ ] Doc de como adicionar um case novo  

**v1.0 (PR5–PR7):**

- [ ] 4 dimensões com confidence ≥ 1.0 no top models  
- [ ] UI ranking mínima  
- [ ] Published catalog com scores frescos  
- [ ] Diff mensurável: routing quality vs table-only em holdout cases  

---

## 15. Esforço e dependências

| Área | Esforço relativo | Depende de |
| --- | --- | --- |
| Tipos + ranker + loader | P | nada |
| Orchestrator + isolation | M | panes/spawn, worktree |
| Suites/fixtures | M–G | design de cases |
| Publisher | P | ranker |
| UI | M | publisher |
| Nightly CI | M | secrets providers |

**Caminho crítico:** fixtures/oracles bons > UI bonita.  
**Bloqueio zero:** schema e router já esperam os dados.

---

## 16. Open Questions (precisam de produto)

1. **Quem paga o eval?** Local-only no machine do user vs CI com keys da org?  
2. **Publicar scores no repo público** ou só `~/.nexus` privado (competidores / custo)?  
3. **Elo entre modelos** (head-to-head) além de absolute scoring — v1.5?  
4. **User-local fine-tune de pesos** (ex.: time > cost) — settings overlay?  
5. **Incluir API-only (fable) no ranking** (sim, para info) mas **nunca** no auto-route (já bloqueado)?

---

## 17. Recomendação final

**Construir o Nexus Eval como produto de primeira classe**, não como script solto.

Ordem correta:

1. **Harness + suite coding mínima + ranker + publisher** (desbloqueia routing real).  
2. Expandir dimensões.  
3. UI e nightly.  

O “leaderboard” é o **efeito colateral** da verdade operacional. O **objetivo** é o router, o review council e o usuário saberem **onde usar cada LLM com evidência**.

Hoje o Nexus está a **um pipeline de avaliação** de distância de ter routing orientado a qualidade. A infraestrutura de consumo já está pronta; falta a fábrica de scores.

---

## 18. Próximo passo sugerido

1. Aprovar Key Decisions D1–D10 e responder Open Questions.  
2. Abrir design formal (`/design`) ou ir direto a PR1 no worktree isolado.  
3. Escrever 8 cases coding com oracles determinísticos antes de qualquer UI.

**Worktree isolado já disponível:**  
`/Users/cleofaspereirarocha/nexus-ide-wt-20260711-2119`  
branch `worktree/isolated-20260711-2119`

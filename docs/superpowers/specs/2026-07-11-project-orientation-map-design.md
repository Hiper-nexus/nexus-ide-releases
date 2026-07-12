# Project Orientation Map v1

**Data:** 2026-07-11  
**Status:** arquitetura aprovada — P0–P4 + bootstrap autopilot (doctor→review→apply→commit)  
**Aprovado em:** 2026-07-11  
**Implementado:** 2026-07-11  
- mapa no open, import graph, Graphify enricher, blast radius em freeze/worktree  
- `runContextBootstrapAutopilot`: propose → quorum review → apply → commit  
- doctor orquestra a cadeia; sem auto-aprovação; TODOs de produto ficam fora do auto-review  
**Escopo:** mapa estrutural automático do repositório no open do workspace, cache
por checkout/HEAD, injeção em agentes e encaixe com o harness de contexto  
**Herda:**
[2026-07-10-nexus-context-verification-harness-design.md](./2026-07-10-nexus-context-verification-harness-design.md)  
**Não substitui:** autoridade `.context`, PREVC, attestations, Truth Graph de
negócio nem Graphify como skill externa

---

## Decisão

O Nexus passa a construir e manter um **Project Orientation Map** nativo, no
processo main, sempre que um workspace abre ou o `HEAD` do checkout muda.

O mapa é **orientação estrutural determinística** — linguagem, árvore, scripts,
símbolos, imports, hubs e presença de docs. Ele **não** é autoridade de negócio
e **nunca** congela contratos, não vira fact bloqueante e não contorna doctor,
attestation ou PREVC.

Objetivo operacional: agentes e o usuário **sabem onde estão no repositório em
segundos**, em todo projeto novo, sem depender de skill externa, sem despejar o
repo no prompt e sem inventar regras de produto.

---

## Problema real

O harness de contexto já existe e é fail-closed:

- `nexus_context_doctor` / `inspectContextReadiness`
- scaffold de `.context` (esqueleto, sem fabricar docs)
- drafts com fontes e hashes, review independente, commit
- freeze de contrato, snapshot por missão, sensores, worktrees

Mas **abrir um projeto** (`workspace.open`) hoje só registra path e identidade.
Não há:

1. leitura estrutural automática do codebase no boot do workspace;
2. cache portátil por `projectId + checkoutId + headSha`;
3. injeção de orientação no kickoff do orquestrador;
4. tool MCP estável para consultar o mapa;
5. bootstrap de drafts de contexto **alimentado** por evidência de código.

Consequências:

- o orquestrador “reaprende” o repo por grep e leitura ad hoc a cada missão;
- projetos sem `.context` ficam `ready=false` e o agente não tem mapa mínimo
  barato para navegar até preencher autoridade;
- Graphify (skill) e Jarvis memory resolvem outras camadas e **não** fecham
  esse buraco no motor do app;
- o symbol index atual é um `Set` de nomes por regex — útil para stale check,
  insuficiente como mapa.

---

## O que o Nexus já possui (reuso)

| Fundação | Situação | Papel neste design |
| --- | --- | --- |
| `ProjectExecutionScope` | projectId, checkoutId, rootRealPath | chave de todo mapa |
| `workspace.open` | path + recents + grants | **gancho L0** do rebuild |
| `buildProjectSymbolIndex` | walk + regex de declarações | v1 base do inventário de símbolos |
| `ingestProjectContext` | docs/facts/candidates | L2 — autoridade, não mapa |
| `inspectContextReadiness` | blockers de `.context` | resumo embutido no mapa |
| `ensureContextScaffold` | dirs + policy/sensors | opcional no open (esqueleto) |
| `compileContextSnapshot` | cápsula por missão | **depois** do freeze; mapa é **antes** |
| `buildMissionKickoffPrompt` | pipeline PREVC no orquestrador | recebe bloco Orientation |
| `ProjectRuntimeManager` + runtime dirs | stores por checkout | cache de mapa em runtime local |
| Graphify (skill externa) | grafo rico com communities | **adapter opcional L1+**, nunca gate |
| Jarvis memory | fatos key/value por checkout | memória de preferência, não mapa |

---

## Três camadas de conhecimento (não misturar)

```text
┌─────────────────────────────────────────────────────────────┐
│ L1  STRUCTURAL MAP (este design)                            │
│     Determinístico · regenerável · sem LLM no path crítico  │
│     “Onde está o código e como se conecta?”                 │
├─────────────────────────────────────────────────────────────┤
│ L2  BUSINESS AUTHORITY (.context / harness)                 │
│     Versionado · attestation · fail-closed · bloqueia PREVC │
│     “O que é verdade de produto e o que é proibido?”        │
├─────────────────────────────────────────────────────────────┤
│ L3  WORKING MEMORY (Jarvis / sessão)                        │
│     Preferências e atalhos · não bloqueia missão            │
│     “O que o usuário pediu lembrar neste checkout?”         │
└─────────────────────────────────────────────────────────────┘
```

| Camada | Pode ser automática no open? | Pode bloquear freeze? | Pode ser inventada por LLM? |
| --- | --- | --- | --- |
| L1 Structural Map | **Sim (obrigatório)** | **Não** | **Não** no path crítico |
| L2 Business Authority | Scaffold sim; docs só via draft+review | **Sim** | Só como **candidate/draft** |
| L3 Working Memory | Sim (ler cache) | **Não** | Sim, com caps |

Regra de ouro: **L1 nunca vira fact de L2 sem draft, fontes e review independente.**

---

## Invariantes não negociáveis

1. Path absoluto é atributo local; identidade do mapa é
   `projectId + checkoutId + headSha` (ou `no-git` + tree fingerprint).
2. O mapa **não** entra em `contextRevision` como autoridade de negócio.
3. O mapa **não** satisfaz `missing-business-context` nem cria attestations.
4. Rebuild no open **não bloqueia** a UI; falha de índice é degradação
   graceful (`status: partial | failed`), nunca crash do app.
5. Walk respeita skip dirs (`.git`, `node_modules`, `dist`, …), limites de
   arquivos/bytes e **nunca** segue symlinks para fora do root realpath.
6. Conteúdo de secrets (`.env`, chaves, tokens) **não** entra no mapa; só
   presença/paths redacted quando útil.
7. Graphify, embeddings e LLM **não** são dependências hard do v1.
8. Agents leem o mapa via MCP/scope; workers **não** escrevem o cache de mapa
   como se fosse autoridade.
9. Trocar workspace na UI não reescreve mapa de execução em andamento noutro
   checkout.
10. Artefatos de mapa vivem no **runtime local do checkout**, não no Git do
    projeto do usuário (salvo export explícito futuro).

---

## Arquitetura alvo

```text
workspace.open / HEAD change / manual refresh
        │
        ▼
 ProjectOrientationService (main)
        │
        ├─ detect scope (ProjectExecutionScope)
        ├─ resolve headSha | treeFingerprint
        ├─ cache lookup (hit → return)
        ├─ build phases (L1a → L1b → L1c)
        ├─ attach contextReadiness summary (read-only doctor)
        ├─ render orientationMarkdown
        ├─ persist cache + emit orientation:changed
        └─ optional: Graphify enricher (L1+)
        │
        ▼
 Consumers
   ├─ mission kickoff prompt (orquestrador)
   ├─ MCP nexus_code_map_*
   ├─ UI readiness / project home
   ├─ context bootstrap proposer (Fase B)
   └─ future: worktree ownership / blast radius hints
```

### Posição no harness existente

```text
Nexus Core
├── Project Runtime Manager
│   └── Project Runtime(projectId, checkoutId)
│       ├── ProjectOrientationService   ← NOVO (L1)
│       ├── Context Ingestor            (L2)
│       ├── Truth Graph                 (L2)
│       ├── Context Snapshot Compiler   (missão)
│       ├── Contract Compiler + PREVC
│       └── …
```

O Orientation Map preenche o `index.db` / diretório de mapas previsto no harness
como **camada de code intelligence**, sem usurpar o corpus de autoridade.

---

## Modelo de dados

### Identidade e status

```ts
type OrientationStatus = 'ready' | 'partial' | 'stale' | 'building' | 'failed';

interface ProjectOrientationMap {
  schemaVersion: 1;
  projectId: string;
  checkoutId: string;
  /** Git object id quando o checkout é um repo válido. */
  headSha: string | null;
  /** Fallback quando não há Git: hash canônico de inventário de paths+mtimes/sizes. */
  treeFingerprint: string;
  builtAt: string; // ISO
  buildDurationMs: number;
  status: OrientationStatus;
  error?: string;
  limits: OrientationLimits;
  inventory: OrientationInventory;
  symbols: OrientationSymbolSummary;
  graph: OrientationGraphSummary;
  docs: OrientationDocsPresence;
  contextSummary: OrientationContextSummary;
  /** Texto compacto pronto para prompt (~1–3k tokens alvo). */
  orientationMarkdown: string;
  /** Hash do payload canônico sem markdown (comparação/cache). */
  mapHash: string;
}
```

### Inventário (L1a — rápido, sempre)

```ts
interface OrientationInventory {
  languages: Array<{ id: string; files: number; bytes: number }>;
  topDirs: Array<{ path: string; files: number; bytes: number }>;
  entrypoints: string[];       // package.json main/bin, src/main, cmd/, app/
  manifests: string[];         // package.json, pyproject.toml, Cargo.toml, go.mod, …
  scripts: Record<string, string>; // npm/pnpm scripts relevantes (test, typecheck, build)
  packageManagers: string[];   // npm | pnpm | yarn | bun | cargo | …
  fileCount: number;
  sourceFileCount: number;
  bytesScanned: number;
}
```

### Símbolos (L1b — reusa/evolui symbol-index)

```ts
interface OrientationSymbolSummary {
  filesScanned: number;
  symbolCount: number;
  /** Top hubs por ocorrência/grau quando grafo existir; senão por contagem de def. */
  hubs: Array<{ name: string; score: number; samplePaths: string[] }>;
  /** Extensões/linguagens cobertas nesta build. */
  coverage: string[];
}
```

v1 **não** exige call graph completo. Hubs podem ser heurísticos
(definições + fan-in de imports quando L1c disponível).

### Grafo resumido (L1c — progressivo)

```ts
interface OrientationGraphSummary {
  mode: 'none' | 'imports' | 'imports+calls' | 'enriched';
  nodeCount: number;
  edgeCount: number;
  /** Amostras de arestas de alto fan-in/fan-out para o markdown. */
  sampleEdges: Array<{ from: string; to: string; relation: 'imports' | 'calls' }>;
  communities?: Array<{ label: string; size: number; hubs: string[] }>;
  enricher?: 'none' | 'graphify';
}
```

v1 default: `imports` para TS/JS quando barato; `none` se timeout/limites.
`graphify` só se adapter opt-in encontrar artefatos válidos e frescos.

### Docs e readiness (somente observação)

```ts
interface OrientationDocsPresence {
  rootDocs: string[];          // AGENTS.md, CLAUDE.md, README.md, DESIGN.md, …
  contextDocsPresent: string[];
  contextDocsMissing: string[];
  hasContextScaffold: boolean;
}

interface OrientationContextSummary {
  ready: boolean;
  contextRevision?: string;
  blockerCodes: string[];      // missing-business-context, …
  warningCodes: string[];
}
```

`contextSummary` chama `inspectContextReadiness` em modo **read-only** (com
symbol set da build). Não escreve `.context`. Scaffold opcional é política de
produto separada (ver § Gatilhos).

### Limites

```ts
interface OrientationLimits {
  maxFiles: number;        // default alinhado ao symbol-index (ex.: 50_000)
  maxFileBytes: number;    // ex.: 2 MiB
  maxTotalBytes: number;   // ex.: 128 MiB
  maxDepth: number;        // ex.: 16
  buildBudgetMs: number;   // ex.: 8_000 soft / 30_000 hard cancel
  markdownMaxChars: number;// ex.: 12_000
}
```

---

## Persistência e cache

Runtime local (não commitado no repo do usuário):

```text
<userData>/projects/<projectId>/checkouts/<checkoutId>/
  maps/
    current.json              # último mapa válido (ou partial)
    by-head/<headSha>.json    # opcional, LRU cap (ex.: 8)
    build-log.jsonl           # opcional, diagnóstico local
```

Alternativa aceitável no v1: tabela SQLite no runtime do checkout
(`orientation_maps`) se o `ProjectRuntimeManager` já concentrar I/O.

Regras de cache:

| Evento | Comportamento |
| --- | --- |
| open, mesmo `headSha`, `current` fresh | hit; `status: ready` |
| open, `headSha` mudou | rebuild async; UI pode mostrar `stale` até pronta |
| open sem Git | `treeFingerprint`; rebuild se inventário divergir |
| rebuild falhou | manter last-good com `status: stale` + `error` |
| `maps.purge` / doctor deep clean | apaga cache do checkout |

Portabilidade: paths no JSON são **sempre relativos ao root do scope**.
`graphify portable-check` spirit: nada de abs paths commitáveis.

---

## Gatilhos

### Obrigatórios

1. **`workspace.open` bem-sucedido** com scope resolvido  
   → `orientation.ensure({ reason: 'workspace-open' })` async
2. **Refresh manual** (UI ou MCP `nexus_code_map_refresh`)
3. **Antes do kickoff do orquestrador** se não houver mapa ready/partial  
   → wait curto (ex.: ≤ 3s) ou injetar “mapa ainda construindo”

### Recomendados (v1.1 se não couber no v1)

4. Mudança de `HEAD` observada (poll git ou hook pós-comando git do Nexus)
5. Após `nexus_context_commit` (só para refrescar `contextSummary`)
6. Após merge de task integrado (blast radius futuro)

### Explicitamente fora do open automático

- full Graphify pipeline
- LLM bootstrap de docs de negócio
- attestations / commit de `.context`

### Scaffold no open

**Default v1:** **não** chamar `ensureContextScaffold` no open (evita escrever no
repo sem intenção).  

**Opt-in** (setting por instalação ou por projeto):
`orientation.scaffoldContextOnOpen = true` → só esqueleto de dirs/policy/sensors,
nunca docs de negócio.

---

## Pipeline de build

### Fase L1a — Inventory (obrigatória, < ~1s em repos médios)

1. `realpath` do root; recusar escape
2. Walk com skip set do symbol-index (+ `.nexus` runtime se aparecer no tree)
3. Contar linguagens, top dirs, manifests
4. Parse leve de `package.json` / equivalentes (scripts, name, workspaces)
5. Detectar entrypoints por convenção

Se L1a falhar → `status: failed`, sem L1b/L1c.

### Fase L1b — Symbols (obrigatória se L1a ok)

1. Reusar `buildProjectSymbolIndex` (ou extrair shared walker)
2. Agregar hubs heurísticos (nome × ocorrências; paths de amostra)
3. Alimentar doctor com `knownSymbols`

Timeout parcial: entregar inventory + symbols parciais → `status: partial`.

### Fase L1c — Import graph (best-effort)

v1 escopo de linguagem:

| Prioridade | Linguagem | Método |
| --- | --- | --- |
| P0 | TS/TSX/JS/JSX | regex/`import`/`require` + resolução relativa barata |
| P1 | Python | `from x import` / `import x` (sem resolver site-packages) |
| P2 | Go/Rust | opcional depois |

Sem TypeScript Program API completa no v1 se custo de boot for alto — preferir
heurística determinística com testes. Evoluir para API oficial em v1.1 se
precisão de ownership exigir.

### Fase L1d — Context summary (read-only)

1. `inspectContextReadiness(scope, { knownSymbols })`
2. Preencher `docs` + `contextSummary`
3. **Não** mutar workspace

### Render `orientationMarkdown`

Template estável (ordem fixa, bom para cache de prompt):

```markdown
# Project orientation

- Project: <name or basename>
- HEAD: <sha12 or no-git>
- Status: ready|partial
- Languages: ts (1200), tsx (400), …
- Scripts: test, typecheck, build
- Entrypoints: src/main/main.ts, …

## Top directories
- src/main (… files)
- src/renderer (…)

## Symbol hubs
- ContextWorkflowService (score …) — src/main/context/…
- …

## Import sketch
- A → B
- …

## Docs & context readiness
- Present: AGENTS.md, …
- Missing context: .context/docs/architecture.md, …
- Ready: false
- Blockers: missing-business-context, missing-structured-invariants, …

## Agent guidance
- Prefer small diffs; reuse existing modules under hubs above.
- Do not invent business rules; use nexus_context_doctor / drafts for authority.
- Structural map is orientation only — not mission authority.
```

Orçamento: truncar seções de grafo/hubs antes de cortar readiness/blockers.

---

## Superfícies de API

### Main service

```ts
interface ProjectOrientationService {
  /** Retorna cache se válido; senão agenda/await build conforme options. */
  ensure(
    scope: ProjectExecutionScope,
    options?: {
      reason: 'workspace-open' | 'refresh' | 'pre-kickoff' | 'head-change';
      waitMs?: number;
      force?: boolean;
    },
  ): Promise<ProjectOrientationMap>;

  get(scope: ProjectExecutionScope): ProjectOrientationMap | null;

  refresh(scope: ProjectExecutionScope): Promise<ProjectOrientationMap>;
}
```

Single-flight por `checkoutId`: rebuilds concorrentes coalescem.

### MCP tools (namespace existente `nexus_*`)

| Tool | Role | Descrição |
| --- | --- | --- |
| `nexus_code_map_get` | qualquer | Retorna mapa atual (ou partial/stale) |
| `nexus_code_map_refresh` | orchestrator/user | Força rebuild |
| `nexus_code_map_query` | qualquer | Busca leve: path prefix, símbolo, hub |

`nexus_code_map_query` v1: filtro determinístico no JSON em memória — **sem**
LLM e **sem** vector DB.

Não criar tool que “promove” item do mapa a fact de `.context`.

### IPC / UI (mínimo v1)

- evento `orientation:changed` → renderer
- indicador no project home / doctor panel: `Mapa: ready · 1.2s · HEAD abcdef`
- não exige UI rica no v1 se MCP + kickoff bastarem; indicador é desejável

### Injeção no kickoff

`buildMissionKickoffPrompt` (e qualquer spawn de orquestrador PREVC) inclui:

```text
## Orientação estrutural do repositório (L1 — não é autoridade)
<orientationMarkdown truncado>
```

Regras:

- se mapa `building` e timeout do wait: injetar stub + “chame nexus_code_map_get”
- se `failed`: injetar inventário mínimo de path + aviso
- workers em task recebem **subset** opcional (paths/símbolos da ownership) em
  fase posterior; v1 foca orquestrador

---

## Graphify adapter (opcional, L1+)

```ts
interface CodeGraphEnricher {
  id: 'graphify';
  detect(scope: ProjectExecutionScope): {
    available: boolean;
    graphPath?: string; // .graphify/graph.json
    stale?: boolean;
  };
  enrich(base: ProjectOrientationMap): Partial<Pick<
    ProjectOrientationMap,
    'graph' | 'symbols' | 'orientationMarkdown'
  >> | null;
}
```

Regras:

- só enriquece se `.graphify/graph.json` existe e passa validação mínima;
- se `needs_update` / branch stale, marcar `graph.mode = 'enriched'` com warning
  no markdown, ou ignorar enricher;
- **nunca** instalar Graphify globalmente nem rodar pipeline completo no open;
- falha do enricher não falha o mapa base.

Isso realiza a linha do harness: *“Graphify pode alimentar a camada estrutural,
mas o formato canônico pertence ao Nexus”*.

---

## Bootstrap de contexto (Fase B — design, implementação após v1 map)

Não faz parte do path crítico do open. Design para não perder o encaixe:

```text
orientation ready
  → (opt-in / mission step) ContextBootstrapProposer
  → lê inventory + hubs + README/AGENTS existentes + testes top-level
  → propõe drafts em .context/docs/* e invariants candidatas
  → cada draft com sources[] e sourceHash reais
  → pipeline já existente:
       nexus_context_draft_propose
       → nexus_context_draft_review_run (outro provider)
       → apply + nexus_context_commit
```

Proibições:

- auto-commit sem review
- auto-attestation
- preencher invariant sem trecho de código/teste/doc fonte
- marcar draft como `asserted` fact sem reviewer

O kickoff já descreve o pipeline de contexto; a Fase B só **gera melhores
propostas** a partir do mapa.

---

## Estrutura de arquivos (proposta de implementação)

```text
src/main/context/
  orientation/
    orientation-types.ts          # schemas zod + tipos
    orientation-walker.ts         # walk compartilhado / limites
    orientation-inventory.ts      # L1a
    orientation-symbols.ts        # L1b (wrap/refactor symbol-index)
    orientation-import-graph.ts   # L1c best-effort
    orientation-markdown.ts       # render estável
    orientation-cache.ts          # read/write maps/
    orientation-service.ts        # ensure/get/refresh + single-flight
    orientation-service.test.ts
    graphify-enricher.ts          # opcional
    graphify-enricher.test.ts

src/main/orch/
  tools-code-map.ts               # MCP tools
  tools-code-map.test.ts

src/main/persistence/
  workspace-store.ts              # hook ensure() no open (async)

src/renderer/orch/
  mission-launcher.ts             # injeta orientationMarkdown
```

Refactors permitidos:

- extrair walker comum de `symbol-index.ts` para `orientation-walker.ts`
- manter `buildProjectSymbolIndex` como API estável (thin wrapper)

---

## Segurança e privacidade

| Risco | Mitigação |
| --- | --- |
| Symlink escape | `realpath` + relative check (mesmo padrão context/symbol) |
| Secret leakage no markdown | skip `.env*`, `*.pem`, key-like basenames; não embutir conteúdo de arquivos |
| Repo enorme | caps de files/bytes/depth + budget de tempo + `partial` |
| Path absoluto em cache | só relativos; scope root só em runtime memory |
| Multi-checkout collision | chave checkoutId no path de cache |
| Agent write abuse | tools de mapa são read/refresh; refresh não altera Git do projeto |

---

## Observabilidade

- breadcrumb/crash: `orientation_build_started|finished|failed`
- métricas locais: durationMs, fileCount, status, cache hit ratio
- **sem** telemetria de conteúdo de código ou nomes de símbolos para nuvem no v1

---

## Plano de implementação

### P0 — Orientation core (este design, v1 shippable)

1. Tipos + zod + cache em runtime do checkout  
2. L1a inventory + L1b symbols + L1d readiness summary  
3. `orientationMarkdown` + `mapHash`  
4. `ProjectOrientationService.ensure/get/refresh` + single-flight  
5. Hook async em `workspace.open`  
6. MCP `nexus_code_map_get` / `_refresh`  
7. Injeção no kickoff do orquestrador  
8. Testes unitários com fixtures de repo mínimo e repo “sujo” (symlink, huge)

**Aceite P0:**

- abrir workspace novo sem `.context` gera mapa `ready|partial` em ≤ budget
- segundo open no mesmo HEAD é cache hit
- kickoff contém seção de orientação
- `nexus_code_map_get` retorna o mesmo `mapHash`
- doctor/ freeze **continuam** fail-closed (mapa não “cura” missing docs)

### P1 — Import graph + query

1. L1c imports TS/JS  
2. hubs por fan-in  
3. `nexus_code_map_query`  
4. indicador UI mínimo  

### P2 — Graphify enricher + HEAD watch

1. detect `.graphify/graph.json`  
2. enrich communities se fresco  
3. invalidação em mudança de HEAD  

### P3 — Context bootstrap proposer

1. drafts a partir de mapa + fontes  
2. UI “Gerar rascunhos de contexto”  
3. opt-in auto no open se `ready=false`

### P4 — Blast radius (pós-mapa maduro)

1. ownership hints em `nexus_worktree_create`  
2. review-delta style paths para merge  
3. ainda advisory até sensores/review existentes decidirem gates

---

## Testes de aceite do produto

1. Workspace sem Git: mapa usa `treeFingerprint`, status não é `failed` só por
   ausência de Git.
2. Workspace com Git: `headSha` preenchido; commit novo → rebuild (P2) ou
   refresh manual muda `mapHash`.
3. `node_modules` e `.git` não inflacionam hubs.
4. Symlink para fora do root não é seguido.
5. Arquivo `.env` não aparece com conteúdo no markdown.
6. Projeto enorme respeita caps e devolve `partial` em vez de travar a UI.
7. Abrir projeto A, depois B: mapas isolados por checkout; execução A intacta.
8. `ready=false` no context doctor permanece false mesmo com mapa `ready`.
9. Orquestrador recebe orientação sem chamar Graphify.
10. Graphify ausente: mapa base intacto.
11. Graphify presente e stale: não corrompe mapa base; no máximo warning.
12. Worker não consegue “promover” mapa a autoridade via tool inexistente.
13. Cache miss vs hit: segundo `ensure` sem `force` não re-walk completo
    (assert via spy de walker ou duration/build counter).
14. Kickoff com mapa `building` não bloqueia missão indefinidamente.

---

## Não-objetivos (v1)

- embeddings / vector RAG como fonte de verdade  
- Neo4j ou DB de grafo externa  
- instalar ou invocar Graphify CLI no open  
- substituir Truth Graph / snapshot de missão  
- auto-preencher e commitar `.context` sem review  
- análise semântica LLM no path crítico de open  
- suporte perfeito a monorepos multi-linguagem exóticos (melhoria incremental)  
- UI de Ontology Studio embutida  

---

## Relação com o kickoff atual

Hoje o kickoff ordena:

1. mission + `nexus_context_doctor`  
2. scaffold / drafts / review / commit  
3. freeze contract  
4. tasks / worktrees / route  
5. merge + sensores  

Com Orientation Map:

```text
0. (automático) mapa L1 no open
1. kickoff já carrega orientação L1
2. doctor / scaffold / drafts (L2) — agora com mapa para fundamentar sources
3. freeze → capsule de missão (L2 filtrada)
4. execução …
```

Passo 0 reduz tokens gastos em exploração cega; passos 2–3 preservam o modelo
de autoridade que o produto já escolheu.

---

## Riscos e trade-offs

| Risco | Mitigação |
| --- | --- |
| Open fica lento em monorepos | budget + partial + cache + skip dirs agressivo |
| Hubs regex ruidosos | limitar amostra; P1 melhora com imports |
| Agente trata mapa como regra de negócio | wording fixo no markdown + tools docs |
| Duplicação walker symbol-index | extrair módulo único na implementação |
| Expectativa de “Graphify no app” | documentar enricher opcional; base nativa suficiente |
| Escrita acidental no repo | open default não scaffold; cache só em userData |

---

## Decisões fechadas na aprovação (2026-07-11)

1. **Scaffold no open:** **off** (não escreve `.context` no open).  
2. **Budget default:** 30s hard no build de inventário (soft 8s fica para P1 UI).  
3. **IPC no P0:** `orientation.get/ensure/refresh` + injeção no kickoff (sem painel
   doctor dedicado ainda).  
4. **Cache:** JSON em `<userData>/orientation-maps/…/current.json`.  
5. **README:** presença em `docs.rootDocs`; sem corpo longo no markdown.

---

## Resumo executivo

| | |
| --- | --- |
| **O quê** | Mapa estrutural nativo por checkout/HEAD |
| **Quando** | Todo `workspace.open` (+ refresh) |
| **Como** | Inventory + symbols + readiness (+ imports progressivo) |
| **Onde vive** | Runtime local do checkout, não Git do user |
| **Para quem** | Orquestrador, MCP, UI, bootstrap futuro |
| **O que não é** | Autoridade de negócio, Graphify hard dep, RAG |
| **Por que importa** | Código melhor porque o sistema **sempre** sabe a forma do repo antes de pedir mudanças |

---

## Próximo passo após aprovação

Implementar **P0** no worktree isolado (`nexus-ide-wt` ou branch dedicada), com
testes de aceite 1–9 e 12–14, sem alterar o pipeline fail-closed de contexto.

Critério de pronto P0: *“Abri um projeto qualquer e, em segundos, o Nexus e o
orquestrador já têm um mapa honesto do código — sem fingir que já entendem o
negócio.”*

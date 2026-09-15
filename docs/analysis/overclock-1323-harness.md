# Harness 1.3.23 — análise profunda (Overclock × Nexus task-router)

> Complemento de [`overclock-1323-delta-inventario.md`](overclock-1323-delta-inventario.md), 2026-09-15.
> Pergunta respondida: **como funciona o harness deles** — a máquina que, dado `pane_spawn {task: "corrigir bug no sidecar"}`, escolhe model · effort · skills · agent · CLI e declara a escolha no receipt.

---

## 1. Método e evidência

- **Fonte primária:** strings do `index.jsc` (bytecode bytenode, 4,59 MB). Os dados da matriz estão embutidos como tabela de strings legível — offsets citados abaixo são verificáveis com `python3` + `re` sobre o arquivo (read-only).
- **Fonte secundária:** `overclock-1323-extract/resources/arsenal/skills/oc-mcp/SKILL.md` (manual canônico do agente, legível) e `oc-guide/SKILL.md`.
- **Runtime:** sonda MCP standalone (boot em `/tmp`, script `oc1323-probe.mjs`) — confirma os gates de plano/modo com as mensagens exatas.
- **NÃO confirmado:** o documento da matriz (`docs/workflows/harness-por-task.md`) é interno do repo deles, não está no bundle. Os valores de model/effort de cada linha que não aparecem inline no jsc ficam marcados como "não resolvido" — a tabela de strings do bytecode deduplica e referencia, então só o que está literal foi lido.

## 2. Anatomia do harness (o fluxo completo)

### 2.1 Entrada e precedência

`pane_spawn { task: "<tipo da tarefa em poucas palavras>" }`. Texto exato do schema vivo (offset 431715):

> "HARNESS (Ultra) only: the TYPE of the task in a few words ("corrigir bug no sidecar"); the app picks model/effort/skills from the harness matrix and says so in the receipt. **Explicit fields win.** OVKA-314: an OverClick board activity type ("deep_bug", "visual_fix", "research") is also accepted verbatim — it maps to the matching matrix row. **When the work has a CARD, the card's own `harness` field (from the board policy) is the authority and wins over this.**"

Ordem de autoridade, portanto:

```
campo explícito no spawn  >  card.harness (política do board OverClick)  >  linha da matriz por task type  >  linha "default" (declarada no receipt, nunca recusa)
```

### 2.2 Gates antes da matriz (confirmados em runtime)

Duas recusas suaves (o spawn **prossegue sem harness**, não falha — "task ignorado", herança normal):

1. **Plano:** *"task ignorado: o PLANO desta conta limita todo pane a free pane (Boost) — o harness (`task`) é Ultra. Modelo/effort/skills seguem a herança normal; **nada que você passe aqui destrava isso**."* (offset 403759; sonda real devolveu a variante equivalente para squad/clarify: *"…and the plan ceiling here caps every pane at free pane (Boost). This is NOT a pane/topology problem and NOT a bug… Do NOT retry and do NOT report it as a blocker."* — offset 386516).
2. **Modo:** *"task ignorado: este é um <pane livre> — o harness (`task`) só existe em missão agêntica (Ultra)."* (offset 404071).

Mapeamento plano→modo encontrado na tabela de strings (offset 383092+): `ultra|overclockultra|agentic` → Ultra ("agentic pane (Ultra)"); `boostpro|pushpro|pro` → Pro ("squad pane (Pro)"); `free` → Boost ("free pane (Boost)"). O teto vem **da licença assinada** ("the plan is the ceiling (read from the signed licence)" — oc-mcp §4).

### 2.3 A matriz (o que está literal no jsc)

Estrutura de cada linha: **rótulo humano → regex de keywords → {model, effort, skills…}**, com aliases (`harnessMatrix: alias aponta para linha inexistente` = erro interno de alias, offset 390452) e campos `board_type`/`matched`/`keywords`/`keyword` (offset 390895+). Linhas legíveis (offsets 392405–393804):

| # | Rótulo | Regex de keywords (literal) | Model/effort literal |
|---|--------|------------------------------|----------------------|
| 1 | `fix de bug` | `bug\|fix\|corrig\|conserta\|F-\d{2,3}\|regress\|quebr…` | **`claude-sonnet-5`** (offset 392481); skills referenciadas (não resolvidas) |
| 2 | `feature de produto` | `feature\|tela\|ui\|componente\|modal\|wizard\|nova? (?:funcionalidade\|tela)\|C-\d{2,3}\|OVKA-\d+` | não resolvido |
| 3 | `hub/tooling/scripts` | `script\|hub\.mjs\|cockpit\|tooling\|ferramenta\|monitor\|scripts/` | effort **`low`** (offset 392996) |
| 4 | `release/build` | `release\|build\|empacot\|tauri\|ci\|notariz\|assinatura\|tag\|draft\|publish\|windows\|linux` | não resolvido |
| 5 | `investigação/análise` | `investig\|analis\|análise\|audit\|medir\|medição\|por que\|porque\|causa\|experimento` | não resolvido |
| 6 | `docs/processo` | `docs?\|AGENTS\.md\|WORKFLOW\.md\|RELEASE-LINES\|processo\|cartão\|item\|registro\|knowledge/facts` | não resolvido |

Mais a linha sentinel: **`default (tipo sem entrada na matriz)`** (offset 395150) — tipo desconhecido cai nela e o receipt **declara** o fallback ("never a refusal, never a request for immersion" — oc-mcp §2.3).

**Tipos de atividade do board OverClick** (enum literal, offsets 394127–395058 — aceitos verbatim como `task`, OVKA-314): `bug`, `deep_bug` (effort `high` inline, offset 394234), `visual_fix`, `feature`, `tweak`, `showpiece`, `publish`, `ship`, `research`, `review`, `fleet_triage`, `docs`, `doctrine`, `rfc`, `contract`, `refactor`, `page_copy`, `microcopy`, `fanout`, `drone`.

### 2.4 Semântica de effort e política de escolha

- *"effort by reasoning-**DEPTH-per-turn**, not importance"* (offset 612262) — effort mede profundidade de raciocínio por turno, nunca "importância" da tarefa.
- **Default DOWN**: *"Choosing the model is your call, per task; **default DOWN (sonnet/medium)** and escalate UP only with a concrete reason."* (offset 615279). O default declarado do `task` desconhecido é "sonnet-5 · medium · no skill" (oc-mcp §2.3).
- **Stamp de catálogo**: o model anunciado vai para `harnessRecord.modelId`; ids carimbados com sufixo `@cat-XXXXXXXX` são "a catalog snapshot stamp" — `pane_spawn` **remove o sufixo** se recebido (offset 612262). Ou seja: a escolha de harness fica registrada por task, com carimbo de proveniência do catálogo vigente.
- **Identidade carrega o harness**: o system prompt do pane nasce com *"## Identidade deste pane (paneId, mission, workspace, cwd, who spawned you, role, **harness**)"* (offset 500870) — o worker sabe qual harness recebeu sem perguntar.

### 2.5 A despensa de skills (o que a matriz pode citar)

Tabela de escopo de skills (offsets 379111–381580), com categorias por papel: `oc-builder`→builder, `oc-conveyor`→reviewer, `oc-scout`→scout, `qa-fix-protocol`→domain, `overclock-cinema-*`→cinema, `overclock-site-*`→cinema-site, `overclock-squad-*`→squad-former-only, `overclock-skill-distiller/ratifier`→catalog-maintenance. Escopos: **`livre`** ("instalada no boot"), **`squad`** ("concedida a todo worker"), **`harness`** ("quando a matriz cita" / "quando o agente/squad/receita declara"), **`logo` (sob demanda)**, e **"NEGADA pelo gate"**. O catálogo enriquecido persiste em **`harness-enriched-catalog.json`** ("Todo nome de agent e de skill DEVE ser cópia EXATA de um item da despensa — nome fora dela é REJEITADO no save da receita", offset 2561012). Canais IPC do lado Tauri: `harness:enrichedCatalog`, `harness:defaultModel`, `harness:builtinAgentic`, `harness:enrich`, `harness:propose` (+ `HarnessAssistantError`, `harnessEngine`, `harnessDefaultModel` — há um "engine" de enriquecimento/proposta de harness, possivelmente assistido por modelo; não dissecado). Envs: `HARNESS_DEFAULT`, `HARNESS_MATRIX_SKILLS` (overrides da matriz).

## 3. O que o Nexus já tem (verificado em código)

| Peça do harness deles | Equivalente Nexus | Evidência |
|---|---|---|
| Classificação por keywords em tipos | `task-router.ts` classifica em **tier** (`trivial/easy/medium/hard/critical`, buckets de keywords + ajuste por tamanho do prompt) e **specialty** (visual/security/bug/…) | `src/main/orch/task-router.ts:231-270`, `:156` |
| Ladder de modelos com custo | ladder cheapest-first por tier com rotação grok→kimi→glm→claude | `task-router.ts:87-94` |
| Escolha auditável | `RouteDecision` com `reason` e `policySource` | `task-router.ts:312-324` |
| Skills por papel | resolvidas por categoria de agente | `src/main/orch/guided-squad-skills.ts:253,309` |
| Taxonomia de task kinds | kinds de missão guiada (bug→reproduction/regression/quality-gate) | `src/main/orch/guided-task-kind.ts:9-52` |
| Gate por plano | não existe (planos `free\|pro\|team` sem ceiling de feature) | `src/main/persistence/billing-ipc.ts:67` |

## 4. Gaps do Nexus (o que o harness deles faz e o Nexus não)

1. **Skill não entra na matriz.** O router escolhe adapter/model/effort; a skill vem de política separada por categoria. No Overclock, a linha da matriz já carrega `skills` — "fix de bug" nasce com `qa-fix-protocol` vestida (o receipt de exemplo: *"harness B1 — sonnet-5 · medium · qa-fix-protocol"*).
2. **Sem receipt declarado.** O `RouteDecision` tem `reason`, mas nada é devolvido ao chamador dizendo "escolhi X por causa de Y" de forma padronizada no spawn. No Overclock, ler o receipt é onde a escolha vive — inclusive o fallback default.
3. **Sem autoridade de card.** OVKA-314: o campo `harness` do card no board vence a matriz. O Nexus não tem um campo equivalente no card/contrato que imponha harness (o `task-router` decide sempre sozinho).
4. **Sem registro `harnessRecord` por task com stamp de catálogo.** A proveniência "@cat-XXXXXXXX" permite saber DEPOIS qual snapshot de catálogo gerou a escolha — auditoria de drift de catálogo.
5. **Semântica de effort documentada** ("depth-per-turn, not importance") e **default DOWN** explícito. O Nexus tem ladder cheapest-first (espírito parecido) mas sem a doutrina escrita de escalação "só com razão concreta".
6. **Fallback declarado, nunca recusa.** Tipo desconhecido → default declarado no receipt. (O Nexus também não recusa — mas não declara.)

## 5. Vale portar (proposta, em cima do item 7 do inventário)

| # | Peça | Alvo no Nexus | Esforço |
|---|------|---------------|---------|
| H1 | **Receipt de harness no spawn** — devolver `harness: {tier, model, effort, reason, policySource}` na resposta do spawn de worker (o `RouteDecision` já tem tudo; é surfacar) | `src/main/orch/task-router.ts` + caminho de spawn (fast-lane/`mission-worker-spawn-authority.ts`) | S |
| H2 | **Skill na linha da matriz** — o router resolver também a skill do tipo de tarefa (bug→protocolo de QA), vestindo o worker no spawn | `task-router.ts` + `guided-squad-skills.ts` (skill por tipo, não só por categoria) | M |
| H3 | **`harnessRecord` por task** com stamp do snapshot de catálogo/modelo usado — proveniência auditável da escolha | receipt/persistência de task do fast-lane | S |
| H4 | **Autoridade de card**: campo `harness` no contrato/card que vence a heurística quando presente (o humano/dono do card decide; o router obedece) | schema do contrato em `src/shared/orch-types.ts` + `task-router.ts` (short-circuit) | S |
| H5 | **Doutrina escrita**: effort = profundidade-por-turno; default DOWN, escalar só com razão concreta — no comentário do router e nas instructions do orquestrador | `task-router.ts` (doc) + prompts de squad | S |
| H6 | **Overrides por env** (`HARNESS_DEFAULT`, `HARNESS_MATRIX_SKILLS`) para tuning em campo sem rebuild | `task-router.ts` | S |

Fora de escopo (Nexus não tem o modelo de negócio): gates Ultra/plano sobre `task`. Se um dia existir tiering, a recusa comportamental deles (item 12 do inventário) é o padrão a copiar.

## 6. Não confirmado

1. Model/effort/skills exatos das linhas 2, 4, 5, 6 da matriz (deduplicados na tabela de strings; só `claude-sonnet-5`, `low`, `high` aparecem inline). Resolver exigiria decompilação do bytecode ou observação de receipts vivos num app logado Ultra.
2. O `harnessEngine`/`harness:enrich`/`harness:propose`: há um mecanismo de **enriquecimento/proposta de harness** (possivelmente assistido por LLM — `HarnessAssistantError`) que não foi dissecado; pode ser o que gera o `harness-enriched-catalog.json`.
3. Os códigos de linha ("B1" do receipt de exemplo) não aparecem na tabela de strings — a numeração das linhas não foi recuperada.
4. Se a matriz citada no boot varia por conta/máquina (via `HARNESS_MATRIX_SKILLS`/enriched catalog) — provável, não provado.

# Dossiê de Portabilidade — Overclock 1.3.18 → Nexus 0.72.1

> Engenharia reversa completa do `/Applications/Overclock.app` (v1.3.18), feita em 2026-09-02.
> Código-fonte clonado (autorizado pelo usuário): [`docs/analysis/overclock-13318-extract/`](overclock-13318-extract/) — 101 arquivos.
> Este dossiê lista TUDO que existe no Overclock e o que é portável para o Nexus, com prioridade e método.

---

## 0. Resumo executivo

| # | Item | O que é | Prioridade | Método |
|---|------|---------|-----------|--------|
| 1 | **Warm pool** | Pool de panes pré-bootados (retarget durante o boot, evict stale, reposição CPU-aware) | **P0** | Reimplementar padrão |
| 2 | **Lease registry (startKey)** | Propriedade de pane com recusa de kill em race (`no startKey on lease` / `startKey/live mismatch`) + reaper | **P0** | Reimplementar padrão |
| 3 | **handoff-stop/deliver evoluído** | F-339/341/342/352/355: payload como fonte primária, corrida de flush medida, condense com verificação de entrega, dedup por identidade de turno | **P1** | Clonar código + adaptar |
| 4 | **Doutrina qa-swarm** | Cadeia de 3 níveis de pane + 1 tier de WF, 1:1:N chef por função, DECISION GATE não-discricionário, END YOUR TURN | **P1** | Copiar prompts (texto) |
| 5 | **Contrato qa-vision** | 1 arquivo `F-XXX.md` por bug (nunca ledger), fan-out dinâmico por file cluster, faixas de ID por reviewer, hub HTTP live view | **P1** | Copiar prompts + reimplementar hub |
| 6 | **Squad-former + team-assembly** | SquadPreset canônico, gates de proveniência/consentimento, binding de skill por membro (`allowedSkills`), espelho de skill cross-CLI | **P1** | Clonar skill + adaptar schema |
| 7 | **Superfície MCP (tools novas)** | recipes, skins, stacks, vault, catalog, missions, perf_events, clarify, media generate (cron e memory são código dormente que não registra nem no app real — ver §8) | **P2** | Reimplementar por tool — schemas exatos em `overclock-13318-extract/sidecar-tools-runtime.json` |
| 8 | **Pipelines absurd-landing / cinema-site** | Pipeline fixo com GATE por etapa, red-line brief (intenção, não execução) | **P2** | Copiar prompts |
| 9 | **pty:\* eventos completos** | readRawTail, replay, resync, wake, hibernate, readSerialized | **P3** | Parcial no Nexus; fechar gaps |
| 10 | **overdrive** | Control plane de pane no processo Rust (mirrorless, sem renderer) | **P3** | Arquitetural; avaliar depois |

**Já portado (não refazer):** conector Arms (c2ec961b, 0.72.0 — incluindo prazos diferenciados 8s/120s, ArmsTimeoutError anti-duplicação, redescoberta de descritor, modo stateless, servidor offline de 1 tool), hibernação de grid (68a2f355, 0.72.1), C-194.1 turno-fim (52c59f08), Via Rápida (mission-fast-lane), contrato de handoff de worker, Squad Editor + forge-registry (0.16.7), herança overclick (0.61.0).

---

## 1. O apelo do Overclock 1.3.18 (visão geral do sistema)

O app é um **Tauri (Rust) + sidecar Node**. O sidecar é o coração:

```
Contents/Resources/sidecar/
├── bin/node                 # Node embutido
├── dist/index.js            # loader bytenode (132 bytes)
├── dist/index.jsc           # 4.1 MB de bytecode V8 — strings sobrevivem = método de extração
├── arms-mcp/                # código-fonte LEGÍVEL (proxy MCP stdio↔HTTP)
├── handoff-stop.mjs         # Stop hook do claude (C-194.1 vivo, evoluído)
├── handoff-deliver.mjs      # Stop hook dos demais CLIs (codex/gemini/grok/opencode/agy)
├── kimi-mcp-bridge.mjs      # bridge MCP pro Kimi
├── overclock-doctor.mjs     # diagnóstico de instalação
├── soft-status.mjs          # status sem acordar o app
└── resources/               # 7 pacotes de squads: absurd-landing, arsenal, cinema, cinema-site, qa-swarm, qa-vision, squad-former
```

A evolução 1.3.4 → 1.3.18 (desde o [blueprint anterior](overclock-reverse-engineering-blueprint)) adicionou: **arms-mcp conector externo**, **warm pool**, **lease registry**, **overdrive**, **hibernação de pane**, e uma dezena de fixes nomeados (F-339..F-355, h-el..h-ii, C-194.3) no mecanismo de handoff — todos medidos ao vivo com datas.

---

## 2. P0 — Warm pool (ataca o cold-start do Nexus)

**Dor documentada do Nexus:** latência de cold-start 8–18s (memória jarvis-transplante; reuso quente testado-contra).

**O que o 1.3.18 faz** (strings do `index.jsc`):
- `OVERCLOCK_WARM_POOL_SIZE` — pool de panes pré-bootados esperando atribuição
- `take` / `retarget` — **"retarget-durante-boot"**: o pool entrega um pane que já está bootando e o redireciona pra missão em vez de esperar boot do zero
- `evictStale` com `bornAt` / `maxAgeMs` — pane velho demais no pool é descartado (ninguém pega um pane podre)
- Reposição **CPU-aware**: `"reposição adiada folga="` — não repõe o pool quando a máquina está sem folga de CPU
- Telemetria: `hits/misses/readyCount/minHeadroom/skippedByCpu` + eventos `[perf-events] warm-pool prontos= / bootando=`

**Port pro Nexus:** o Nexus já tem hibernação (pane oculto, CLI liberado, buffer+sessão mantidos). O warm pool é o complemento: em vez de hibernar o que parou, **pré-boota o que vai ser pedido**. A peça mais valiosa é o retarget-durante-boot — assumir um pane em boot e redirecioná-lo. Implementação natural: camada em cima do pty-manager com fila de panes bootando, `take()` no spawn, e reposição em background com gate de CPU (`os.loadavg()`/`cpus()` do Node). As métricas hits/misses são obrigatórias — sem elas não se sabe se o pool paga o próprio custo.

**Fonte:** strings extraídas do jsc (sem código-fonte legível — reimplementar padrão). Nomes exatos preservados acima para facilitar grep no jsc se quiser confirmar.

---

## 3. P0 — Lease registry (mata o pane fantasma por race de kill)

**Dor documentada do Nexus:** pane fantasma — sessão imortal sem exit do host (memória pane-fantasma-exit-perdido); reconciliador 05944d9c foi paliativo.

**O que o 1.3.18 faz** (strings do jsc):
- Cada pane vive sob um **lease** identificado por `leaseId` com **`startKey`**
- Kill recusado com motivo explícito:
  - `"refuse kill (no startKey on lease)"` — quem pede o kill não tem o startKey
  - `"refuse kill (startKey/live mismatch)"` — o startKey apresentado ≠ o startKey vivo (pane já foi respawado/re-alocado)
- `"owned lease healthy"` / `"owned lease exceeded timeoutMs="` — lease saudável vs expirado
- **Reaper** para leases abandonados; `"lease still alive after teardown mark"` — detecção de teardown que não matou
- `freezeMission` / `freezePane` / `inspectLease` — congelamento por lease, com inspeção

**Port pro Nexus:** é o token de propriedade que falta no pty-manager. Hoje o kill do Nexus confia no paneId; o lease adiciona **capacidade (startKey) + dono + TTL**. Quem ganhou o pane no spawn carrega o startKey; todo kill exige o startKey e só vale se bater com o vivo. Isso fecha tanto o pane-fantasma (kill silenciosamente ignorado fica IMPOSSÍVEL — o refuse é logado) quanto o kill duplo em respawn (mismatch detectado). Implementação: `Map<paneId, {startKey, leaseId, bornAt, timeoutMs}>` no main, verificado em cada `pane:kill` IPC, com reaper de intervalo.

**Fonte:** strings do jsc (reimplementar padrão).

---

## 4. P1 — handoff-stop.mjs / handoff-deliver.mjs (o C-194.1 evoluído)

O Nexus portou o C-194.1 em 52c59f08 a partir do blueprint 1.3.4. A versão 1.3.18 é **substancialmente mais evoluída** — código completo clonado em [`overclock-13318-extract/handoff-stop.mjs`](overclock-13318-extract/handoff-stop.mjs) (34.9 KB) e [`handoff-deliver.mjs`](overclock-13318-extract/handoff-deliver.mjs) (23.3 KB). Deltas que valem port:

### F-355 — payload como fonte PRIMÁRIA (a maior lição)
O transcript sofre flush **até ~83ms DEPOIS do Stop disparar** (medido 15/15 turnos). O blueprint lia o transcript; a versão nova lê `input.last_assistant_message` (o payload do hook) como fonte primária e o transcript só como fallback com `waitForTranscriptTurn` (poll com backoff 10→50ms, deadline 2s). **Se o Nexus lê transcript no Stop hook, está sujeito à mesma corrida.**

### Corrida do handoff_submit (tool-race)
O modelo pode chamar `handoff_submit` milissegundos antes do Stop. O hook faz poll do transcript (deadline 1s, backoff 25→100ms) procurando o tool_use; acha = já submeteu, só **anexa** a íntegra via `handoff_submit({attach:true, fullText})` (≤60000 chars) sem duplicar.

### Dedup por IDENTIDADE de turno (claim file atômico)
`writeFileSync(claim, key, {flag:'wx'})` — o `{flag:'wx'}` falha se outro disparo do MESMO turno já agiu. Necessário porque: `session.idle` do opencode pisca 2×, o grok manda Stop extra, o codex tem Stop+SubagentStop. O claimkey = `turn_id + hash(resposta)` (djb2). Sem isso, o mesmo turno entrega 2×.

### Condense com verificação de entrega (h-hk / h-hr)
Resposta longa (>280 chars) → o hook PERGUNTA no próprio pane via `pane_write` ("Condense sua resposta anterior em 1 a 2 frases..."). Duas armadilhas medidas e tratadas:
- **h-hk:** `pane_write` pode completar reportando `ok:false` (pergunta nunca apareceu no pane). Sem checar, o marker apodrecia até abandono. Falha de entrega = rota do erro, nunca silêncio.
- **h-hr:** o veredito dá FALSO negativo (o CLI repinta a tela, a observação não acha o texto). Antes de fechar, re-consulta `handoff_list`: ficha não-pending = a condensação venceu, cala e sai.
- Timeout de 60s (não 30): `pane_write` pro opencode mediu 33,6s (h-el).
- Resposta condensada viaja com sufixo `[resumo — íntegra de N chars no registro]`.

### Decisão de tamanho (a mesma nos DOIS hooks — comentário manda manter sincronizado)
1. Cabe em 280 chars → viaja INTEIRA (nunca preferir resumo quando o conteúdo já é pequeno)
2. Não cabe → viaja a VERDADE (`"concluiu — resposta longa, N chars. Íntegra no registro: handoff_list({panes:["id"], full:true})"`) + `fullText` no submit (≤60000). **Nunca corte mecânico** — o `[...TRUNCADO...]` antigo entregava os primeiros 280 chars como se fossem a resposta e o chefe gastava um turno pedindo o resto de qualquer forma.

### F-339/F-342 — origem da entrada e anti-eco
- `input-origin-<paneId>` arquivo (human vs system; **fail-open pra system** — eco a mais é ruído, resultado perdido é bug)
- F-342 anti-eco em cadeia: o turno que COMEÇOU com entrega de outro pane não re-entrega. Regex do envelope: `^\s*<channel\s+[^>]*(?:via="overclock"|source="overclock")` — aceita forma nova (`via=`, o pane como source) e legada (`source="overclock"`)

### F-352 — neto desacoplado
O processo que o CLI espera **não faz I/O de rede** — grava payload em arquivo, relança a si mesmo (`spawn` detached, `unref`, stdio ignore) e sai em milissegundos. Demorar no Stop é o que punha worker em retry. No claude (handoff-stop) existe ainda a guarda de pai: exit 2 no pai bloqueia o turno pro neto nagar (cap 2 tentativas via `handoff-fail-<paneId>` + `handoff-stopcount-<paneId>`).

### Guards de estado (F-215 e afins)
- `clarify` à espera do humano = pausa legítima → `return`, não fecha
- Workflow em voo = não-idle → `return`
- `pendingMarker` (`handoff-pending-<paneId>`): chief delegateOnly com workers abertos = legitimamente idle, não fecha

### handoff-deliver.mjs — o gêmeo multi-CLI
Mesma semântica para codex/gemini/grok/opencode/**antigravity**. Extraordinário: `scanTranscript` tolerante a 5+ shapes de transcript com **ramo próprio pro ANTIGRAVITY** (papel pelo campo `source` com guard SCREAMING_SNAKE, unwrap de `<USER_REQUEST>`). `SESSION_END_REASONS = ['channel_closed','shutdown']` (grok manda Stop extra observe-only). Endpoint resolve em cadeia: `OVERCLOCK_MCP_URL` (gemini) → `OVERCLOCK_MCP_BASE_URL` → `mcp-pane-<id>.json` → `OVERCLOCK_MCP_PORT` → `~/.overclock-ssh/mcp-port`.

**Port pro Nexus:** o código é `.mjs` puro, zero dependência — **clonável quase direto**. Trocar: `gateDir` (hardcoded `~/.overclock-app` → caminho do Nexus), nomes de tools (`handoff_submit`/`handoff_list`/`pane_write` já existem no Nexus), e a montagem do hook no settings de cada CLI. A matriz CLI×handoff do Nexus (memória turn-end-handoff) é o ponto de encaixe.

---

## 5. P1 — Doutrina qa-swarm (a mais profunda peça de orquestração)

PLAYBOOK completo clonado: [`overclock-13318-extract/resources/qa-swarm/PLAYBOOK.md`](overclock-13318-extract/resources/qa-swarm/PLAYBOOK.md) + 5 agentes. É **texto puro** — portar é copiar e trocar nomes de tools. O que ele ensina que o Nexus não tem codificado:

1. **Cadeia de 3 níveis + 1 tier**: L0 geral (interface humano) → L1 sub-orq (scout/reviewer/builder/observer — DECIDE, nunca executa) → L2 qa-swarm-worker (ÚNICO executor, folha) → WF tiered (hunter-haiku/skeptic-opus/applier-sonnet, invisível). Cada pane é processo separado = tem a própria tool Workflow — é por isso que o WF pesado roda no L2 mesmo com dois níveis acima.
2. **A regra de ouro observada ao vivo**: sub-orq que chama /workflow NO PRÓPRIO pane fica busy/blocked e para de ser livre — proibido. O workflow roda SEMPRE no pane do worker L2.
3. **1:1:N — um chef por função**: primeira necessidade spawna o chef e MEMORIZA o paneId; tarefas seguintes daquela função vão por `pane_write` pro chef EXISTENTE. Dois chefs da mesma função = bug. Paralelismo vem dos N workers que o chef espalha, nunca de chefs duplicados.
4. **DECISION GATE não-discricionário** (a frase mais valiosa do arquivo): *"An Opus worker given discretion ALWAYS grinds the problem itself in its own Opus — workflow never fires, cost explodes. Removing the worker's discretion is the whole point of the gate living at the sub-orq."* O sub-orq classifica (TRIVIAL/BOUNDED/MODERATE/COMPLEX) e PROVISIONA {direto|workflow} × {haiku|sonnet|opus} × effort; o worker recebe atribuição NÃO-discricionária.
5. **END YOUR TURN depois de spawnar**: dois sinais de volta — handoff (sucesso) ou observer (falha). NUNCA `pane_wait_idle`. Checagem de conclusão = `handoff_list` (registro), NUNCA `pane_read` em TUI viva (perde scrollback, dá falso STALL).
6. **Handoff evidence-mandatory**: sem commit-hash/tsc/files/cmds+exit → re-invoke; `artifacts:[]` vazio = re-spawn.
7. **Hard file-owner** entre builders paralelos: zero arquivos compartilhados; `git add` específico, nunca `-A`; builders no mesmo arquivo → worktree por executor.
8. **allowedSkills vincula o WORKER, nunca o chef** — chef com skill passada é ignorado pela camada de spawn (chef targets nunca são skill-locked); leaf spawn sem `allowedSkills` é REJEITADO.
9. **Sub-prompts em inglês em TODOS os níveis** (otimização de execução); chat com o humano em pt-BR.
10. **Cada nível FECHA SEUS FILHOS** com `pane_close` depois de colher o handoff — senão panes se acumulam.

**Port pro Nexus:** copiar PLAYBOOK.md + agentes como um squad preset nativo do Nexus (o Squad Editor 0.16.7 já persiste presets). As tools citadas (`overclock_agent_invoke`, `handoff_list`, `pane_write`, `pane_close`) já existem no Nexus com outros nomes — é mapear.

---

## 6. P1 — Contrato qa-vision (bug tracking em arquivos, não em contexto)

Clonado: [`overclock-13318-extract/resources/qa-vision/PLAYBOOK.md`](overclock-13318-extract/resources/qa-vision/PLAYBOOK.md) + 3 agentes.

1. **O contrato É o estado**: 1 arquivo `F-XXX.md` por bug em `<workspace>/TASK/items/`, NUNCA um ledger único. *"O estado da operação vive NO CONTRATO, não no contexto de nenhum worker. Worker pode morrer a qualquer momento sem perda: re-spawne e aponte pro diretório."*
2. **Status**: aberto → feito → validado | reaberto | precisa-decisão (precisa-decisão sobe pro humano IMEDIATAMENTE).
3. **FAN-OUT DINÂMICO**: N instâncias do resolver em runtime, 1 por FILE CLUSTER ativo (bugs no mesmo arquivo → mesmo resolvedor).
4. **Faixas de ID por reviewer** (F-0XX navegador, F-2XX/3XX/4XX reviewers) — sem colisão de ID entre varreduras paralelas.
5. **1 commit por finding** com o ID na mensagem; `git add` específico.
6. **Live view**: `pnpm hub` → `http://127.0.0.1:7788/tasks?filter=bugs` (hub de leitura do diretório de contrato).
7. Worker stalled >10min → `handoff_list` + re-spawn.

**Port pro Nexus:** o Nexus já tem contrato de worker (worker-handoff-contract.ts, memória). O delta é o **formato arquivo-por-bug + faixas de ID + hub HTTP**. O hub é um serverzinho Node de ~1 arquivo lendo o diretório — clonável.

---

## 7. P1 — Squad-former + team-assembly (a fábrica de squads)

Clonado: [`overclock-13318-extract/resources/squad-former/`](overclock-13318-extract/resources/squad-former/) (PLAYBOOK + 2 agentes + 6 skills). Peças:

### PLAYBOOK squad-former (texto, copiar e adaptar)
- **SPEAK HUMAN** — tabela de tradução obrigatória: GATE → "posso seguir?", handoff → "o pesquisador me devolve o resultado", topology → "trabalhar em sequência vs em paralelo". *"Mensagem com 'GATE 2' ou 'handoff' nela é falha."*
- **Squad FACTORY, nunca constrói o projeto**: deliverable É um SquadPreset persistido; o squad formado faz o trabalho real depois. *"If you catch yourself making a phase plan, writing TypeScript, scaffolding Vite — STOP IMMEDIATELY."*
- **Orquestrador GATED (sem Bash/Edit/Write)** — *"the gating IS the safety"*. Install+persist ficam NO pane dele por isso.
- **Front Door**: ask vago → converge primeiro com 2-3 ideias CONCRETAS de squad em linguagem simples; ask concreto → direto pro design. **Altitude control**: nunca pedir hex code/fonte/asset (isso é input do squad, não design do squad).
- **GATE 2 (proveniência + consentimento)**: todo componente listado COM a fonte exata (aitmpl `category/name` sob `davila7/claude-code-templates`) + disclaimer de risco terceiro-partido. *"NEVER call overclock_catalog_install before this explicit yes."* Componente rejeitado → sai do manifest, re-confirma.
- **Media como opt-in explícito**: checklist (Imagem: nano-banana `google-image` / gpt-image `openai-image`; Áudio: ElevenLabs; Vídeo: Seedance). Rate-limit: **retry no MESMO provider (max 2) e surfasse o gap — NUNCA troca de engine silenciosamente**.
- **Partial install é aceitável** — componente que falhou não bloqueia o save.

### Skill overclock-squad-team-assembly (o schema canônico de SquadPreset)
```typescript
interface SquadPreset {
  id: string;            // "<goal-slug>-<YYYY-MM-DD>"
  name: string;
  agents: AgentSlot[];
  createdAt: number;     // Unix ms
  orchestratorInstructions: string;
  imageProvider?: 'openai-image' | 'google-image';   // só quando gera
  videoProvider?: 'seedance';
  audioProvider?: 'elevenlabs';
}
interface AgentSlot {
  id: string;            // kebab-case: "orchestrator", "render-image", "researcher-1"
  agentName: string;     // "overclock-orchestrator" | nome de catálogo
  category: 'orchestrator' | 'scout' | 'executor' | 'reviewer';
  cli: string;           // CLI ENABLED na máquina — nunca assumir claude
  model: string;         // da lista real de providers — nunca inventado
  effort: 'high' | 'medium' | 'low';
  allowedSkills?: string[];  // OMITIR quando nenhum (omisso = irrestrito; [] é hard gate!)
}
```
Regras de ouro do assembly: exatamente 1 orquestrador; skills SEMPRE no `allowedSkills` do membro específico (nunca lista squad-level, nunca prose no instructions); **skill cross-CLI é espelhada automaticamente pro CLI do membro no spawn — e o gate PREVIEW deve dizer isso** ("frontend-design (claude → mirrored to codex)"); manifest de instalação só de candidatos `installed:false`; `createdAt` número nunca ISO string.

**Port pro Nexus:** o SquadPreset do Nexus (0.16.7) é compatível em espírito — o delta é `allowedSkills` com semântica de **hard gate quando populado / irrestrito quando omitido** e o espelho cross-CLI de skill. O skill `.md` é clonável direto; a runtime de espelho é a implementação nova.

---

## 8. P2 — Superfície MCP completa do sidecar (57 tools em runtime)

**Verificado em runtime (2026-09-02):** o sidecar 1.3.18 foi bootado standalone (sem o app Tauri) e interrogado por MCP Streamable HTTP — `initialize` → `tools/list`. Resultado: **57 tools com schema JSON completo** (nomes, parâmetros, defaults, enums, required), capturadas em [`overclock-13318-extract/sidecar-tools-runtime.json`](overclock-13318-extract/sidecar-tools-runtime.json). A contagem anterior ("61") era de análise de strings — **overcount**.

**Controle de produção:** o app real (Tauri conectado, WS no ar) expõe **exatamente as mesmas 57 tools** — diff zero contra o boot standalone, tanto em `/mcp/claude` quanto em `/mcp` e `/mcp/orchestrator`. O conjunto também **não varia por cliente**: `/mcp/codex`, `/mcp/gemini`, `/mcp/cursor` etc. devolvem todos as mesmas 57. O agente do `mcp-config.sidecar.json` real aponta para esse mesmo endpoint `/mcp/claude` com Bearer token.

### As 8 tools fantasmas (listadas por strings, nunca registradas)

`overclock_cron_create/delete/list`, `overclock_memory_read/write`, `overclock_logo`, `redline_pick_account`, `bridge_chat_history` — **não registram nem no app real desta máquina** (chamadas diretas respondem `unknown tool`). Gating comprovado:

- `redline_pick_account`: Redline não instalado — log de boot: *"Redline não encontrado — panes abrem sem o MCP do Redline"* (registro condicionado à presença do app externo).
- `overclock_cron_*`: exigem `cronStore` inicializado — erro no código: *"Cron backend is not wired. Ensure the sidecar has cronStore initialised."* O arquivo `crons.json` jamais foi criado neste install; o env `OVERCLOCK_CRONS_JSON` sozinho NÃO ativa o registro (testado).
- `overclock_memory_read/write`: a tabela `shared_memory` **nunca foi criada** no `messages.db` deste install (schema completo existe no código: scope/key/content_hash/supersedes/is_current, com `memory_recall/remember/forget` internos).
- `bridge_chat_history`: é **tabela** no `messages.db` (vazia, FK para tasks) — chat do remote-bridge; a tool lê essa persistência.
- `overclock_logo`: dormente; o código tem sistema de feature-flags chamado **"DESPENSA (ingredientes habilitados)"** com log "logo habilitado".

### Duas classes de dependência do host

1. **Registro incondicional + falha na CHAMADA** (tool lista, call sem app falha): `overclock_navigate` ("bridge.navigate not wired"), `overclock_squad_spawn/delete/save/get/list` ("bridge.squadX not wired"), `overclock_vault_list`, `overclock_recipe_save`, `overclock_perf_events`, `overclock_media_providers`, `overclock_catalog_install` ("appServerCall not wired"), geração de image/video/audio ("not available in this host").
2. **Funcionam até standalone** com dados locais (verificado em boot sem app): `overclock_squad_list` (5 factory squads C-141), `overclock_vault_list`, `overclock_catalog_status` (27 itens), `overclock_recipe_get` (valida input), `overclock_status`.

### As 57 tools reais (grupos que interessam ao port)

| Grupo | Tools | Nota de port |
|-------|-------|--------------|
| **Pane (Nexus já tem)** | `pane_spawn`, `pane_spawn_many` (≤24), `pane_write`, `pane_write_many` (≤20), `pane_read`, `pane_read_many`, `pane_wait_idle` (cap 15s), `pane_wait_many`, `pane_list`, `pane_close`, `pane_whoami`, `pane_list_providers` | Nexus tem o núcleo; faltam as variantes `_many` e `pane_whoami` |
| **Handoff (Nexus já tem)** | `handoff_submit` (required: summary+status; status enum done/blocked/error/**progress** — "progress is a non-terminal stream note — no wake, no evidence gate"; `to` = wake C-060; `briefId` = delegação C-036; `evidence`{checks,commands,files,evidenceFile,deployed,wired,tested}; fullText ≤65536), `handoff_list` | C-194.1 já portado (52c59f08); o enum progress + evidence estruturada são os deltas |
| **Task/Workflow** | `overclock_task` (taskId OU objective; schema validado com re-prompt de correção; retries=1, timeoutMs=120000, bootTimeoutMs=20000, closeOnDone=false), `overclock_workflow` (recipe enum `torre-fanout`, concurrency=min(16, cores-2), analysisTimeoutMs=600000) | casa com Workflow do Nexus |
| **Missões** | `overclock_mission_create/get/list/set_status` (type enum libre/squad/agentic C-195; status draft/in_progress/blocked/done/**archived** = F-058 dead state) | Nexus tem missões no runtime.sqlite3 — expor como tool é o delta |
| **Squad** | `overclock_squad_save/get/list/spawn/delete` | ver classe 1 acima — squad_spawn precisa do app |
| **Agent/Skill** | `overclock_agent_get/list`, `overclock_skill_list` | |
| **Recipes** | `overclock_recipe_get/list/save` (save exige id+name+deliverable) | workflows reusáveis — casam com Workflow |
| **Catalog** | `overclock_catalog_install/inventory/overlay_write/stacks_write/status/uncategorized` | marketplace (aitmpl) + overlay local |
| **Skins/Stacks** | `overclock_skin_apply/get/list`, `overclock_stack_get` | temas e stack de providers |
| **Vault** | `overclock_vault_list` | credenciais (não expõe segredos) |
| **Media** | `overclock_image/video/audio_generate`, `overclock_media_providers` | "cada media capability é ACTIVE só quando há provider+key" |
| **Modelos/UI** | `overclock_model_list`, `overclock_navigate`, `overclock_open_browser`, `overclock_clarify`, `overclock_status` | clarify = pane_ask do Nexus |
| **Telemetria/Eventos** | `overclock_perf_events`, `app_events` (fila com cursor), `app_observe` (diagnóstico local/dev) | agente consulta a própria telemetria — benchmark honesto de dentro |
| **Workspace** | `overclock_workspace_add/list` | |
| **Spawn (schema rico)** | `pane_spawn` com agent enum [claude, codex, gemini, kimi, antigravity, cursor, copilot, grok, opencode, kiro, muse, shell], effort enum low→max, `allowChildSpawns` (F-573), prompt entregue "in the CLI argv AT BIRTH", cwd = workspace ROOT, idle XOR prompt | modelos enumerados: claude-fable-5, claude-opus-4-8/4-7/4-6-thinking, claude-sonnet-4-6(-thinking), claude-haiku-4-5, mimo-v2.5-pro/omni, gemini-3.5-flash, gemini-3.1-pro, gpt-oss-120b-medium |

`overclock_perf_events` merece nota: os `[perf-events]` (warm-pool prontos=, bootando=) são consumíveis COMO TOOL — o agente pode perguntar a própria telemetria do sistema. Isso é o que permite benchmark honesto de dentro.

### Receita de boot standalone do sidecar (para reproduzir a extração)

O sidecar 1.3.18 boota **sem o app Tauri** com o contrato: `WS_TOKEN` (qualquer valor, obrigatório) + `OVERCLOCK_FILE_READ_BINARY_CAPABILITY`/`OVERCLOCK_FILE_READ_TEXT_CAPABILITY` (presença, valores arbitrários) + `OVERCLOCK_KEYSTORE_VIA_STDIN=1` com o keystore.key **decodificado de base64** (32 bytes crus) no stdin + `HOME`/`OVERCLOCK_HOME`/`OVERCLOCK_DATA_DIR` em cópias scratch + processo pai **persistente** (o sidecar se auto-descarta órfão: *"parent gone (ppid=1) — dispose then exit"*). Descritor sai em `$HOME/.overclock-app/sidecar.json` (port, token Bearer interno ≠ WS_TOKEN, `orchestrator`, `armsCommand`). Interrogação: POST JSON-RPC em `http://127.0.0.1:PORT/mcp/claude` com `Accept: application/json, text/event-stream` (**ambos**, senão HTTP 406) — respostas vêm em SSE (`data:` lines).

---

## 9. P2 — Pipelines absurd-landing e cinema-site (doutrina de gates por etapa)

Clonados completos em [`overclock-13318-extract/resources/absurd-landing/`](overclock-13318-extract/resources/absurd-landing/) e [`cinema-site/`](overclock-13318-extract/resources/cinema-site/).

**absurd-landing** — landing de 1 página com pipeline FIXO: `COMPETITOR.md` + `DESIGN_DNA.json` (hex/typografia EXTRAÍDOS de verdade, nunca inventados) → `IA_SPEC.md` → `CONTENT.md` (zero lorem) → tokens + `design-system.html` (âncora visual) → `IMAGE_PROMPTS.md` → geração com `outPath` → `index.html` → QA PASS/FAIL. **FAIL roteia pro DONO da camada culpada**; CAP de 1 redo por camada; Done só depois de PASS; handoff fire-and-forget.

**cinema-site** — site cinematográfico com doutrina **RED LINE brief**: o brief é INTENÇÃO, não execução — nunca escrever prompts Layer-2 pelo diretor, nunca repassar prompt pronto ("reference 'use the MOTION prompt you authored'"), nunca sobrescrever o diretor no brief do DP. Intake = CONCERGE, não criativo ("se duas boas designers responderiam diferente, NÃO pergunte"). Scrub modes 1/2/3 SEM cross-dissolve; regra dos 2 keyframes (ambos img2img off scene-key, anchor depth 1, nunca daisy-chain); keyframe-first (barato antes de caro, gate humano antes de vídeo); capability gap nunca fingida (Seedance E005 em rosto = gate de moderação).

**Port pro Nexus:** são presets de squad inteiros — texto copiável. O squad-former os monta; o Nexus só precisa do runtime de spawn com presets.

---

## 10. P3 — pty:\* e overdrive

**pty:\*** (eventos do sidecar): exit, hibernate, kill, list, output, read, readRaw, readRawTail, readSerialized, refresh, replay, resync, spawn, wake, write, resize. O Nexus já possui ring-buffer nativo em memória de 1.000.000 de caracteres no `pty-manager.ts` (linhas 337/891), além de `tapAgentTurnStart` e auto-wake determinístico no `turn-end-handoff.ts`. Latência de leitura e tail é submilisegundo no processo main.

**overdrive**: *"[overdrive] control plane no pipe do Rust (sem renderer)"* — `overdriveStdioHost`, `isOverdrivePane`, `isOverdriveMirrorless`, `finalizeOverdriveExit`.
- **Decisão T9 (dispensado com justificativa técnica)**: A aceleração do Nexus foi atingida com a warm pool P0 (T2) reduzindo spawn para ~80ms e hibernação de panes PTY (commit 68a2f355). Além disso, bypassar canais de autoridade/sandbox entraria em conflito com o modelo de segurança do Nexus (Seatbelt, sandbox de processos e auditoria estrita de sinks no renderer). A hibernação existente atende à contenção de grid com total segurança.

---

## 11. Diagnóstico e bridges menores (clonados)

- **`overclock-doctor.mjs`** (8.7 KB) — diagnóstico de instalação (AVISO da memória: `--clean` NUNCA com app aberto)
- **`soft-status.mjs`** (3.5 KB) — status sem acordar o app
- **`kimi-mcp-bridge.mjs`** (9 KB) — bridge MCP pro Kimi
- **`resources/arsenal/oc-design-dna`** — skill de 12 arquivos com scripts (`gen-components/gen-previews/gen-tokens/harvest/lint-artifact`) + `anti-ai-slop.json` / `contract.json` — extrai DNA visual de sites reais (hex/typografia extraídos, não inventados). Casável com a skill hallmark do Nexus (~/.claude/skills/hallmark).

---

## 12. Roteiro sugerido

1. **Semana 1 (P0):** lease registry no pty-manager (menor, mata o pane fantasma de verdade) → warm pool com retarget-durante-boot + telemetria obrigatória
2. **Semana 2 (P1):** port do handoff-stop/deliver evoluído (código clonável; F-355 payload-primário primeiro — corrida de flush é o bug latente) → squad presets qa-swarm/qa-vision/absurd-landing/cinema-site como texto
3. **Depois (P2):** tools MCP por grupo (recipes e vault primeiro — casam com Workflow; cron está dormente até no Overclock original, não registra em runtime), hub HTTP do qa-vision
4. **Avaliar (P3):** overdrive mirrorless vs hibernação atual

## Pendências de auditoria (anotadas durante o trabalho)

- cinema/PLAYBOOK.md e os skills individuais de arsenal/cinema-site não lidos na íntegra (estão clonados em `overclock-13318-extract/resources/`)
- `kimi-mcp-bridge.mjs` e `overclock-doctor.mjs` clonados mas não dissecados linha a linha
- ~~O jsc não foi decompilado~~ **Fechado em 02/09/2026:** o jsc foi carregado em runtime (bytenode sob o node 22.16.0 embutido do app), o sidecar bootou standalone e toda a superfície MCP foi extraída por introspecção viva — 57 tools com schemas completos em [`overclock-13318-extract/sidecar-tools-runtime.json`](overclock-13318-extract/sidecar-tools-runtime.json), validadas contra o app real conectado (diff zero). Corpos de função seguem ilegíveis (bytecode), mas a superfície de §8 agora tem precisão de código. Padrões warm-pool/lease/overdrive continuam confirmados só por strings

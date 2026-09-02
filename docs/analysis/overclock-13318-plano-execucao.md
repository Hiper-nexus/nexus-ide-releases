# Plano de execução — port do Overclock 1.3.18 para o Nexus

**Este doc é para um LLM executor.** Ele é auto-contido: cada task diz onde está a fonte
(clonada em `docs/analysis/overclock-13318-extract/`), onde está o alvo no repo, o que
fazer, como testar e quando está pronto. Contexto de fundo está no dossiê
(`docs/analysis/overclock-13318-dossie-portabilidade.md`) — leia as seções citadas
quando precisar do porquê; aqui manda o COMO.

Repo: `/Users/cleofasrocha/dev/nexus-ide` (branch `main`). Todos os caminhos relativos a ele.
O app analisado era Overclock 1.3.18 (Tauri + sidecar Node). O Nexus é Electron + TypeScript.

---

## 1. Regras do ambiente — LEIA ANTES DE TOCAR EM QUALQUER COISA

1. **Node**: use Node 22.22.3. A autoridade é `node scripts/check-build-node.mjs`, não
   documentação. `npm test` roda `pretest` que verifica os natives.
2. **node_modules compartilhado**: o repo pode estar aberto em worktrees com `node_modules`
   symlinkado. **NUNCA `npm install` com o symlink ativo** (quebra o symlink e as ABI).
   Dependência nova: instale numa cópia isolada e copie os artefatos, ou coordene.
   **NUNCA `npm run rebuild:electron` no node_modules compartilhado ou com a IDE aberta.**
3. **Rodar testes**: `npm test` (vitest) no checkout principal. Para um arquivo só:
   `npx vitest run src/main/pty/pty-manager.test.ts`. `npm run typecheck` = `tsc --noEmit`.
   Worktree usa o node_modules do repo principal via symlink — roda, mas não instala.
4. **Doutrina da Via Rápida**: `src/main/orch/mission-fast-lane.ts` (~linha 153-155) é o
   motor padrão de missão. **NUNCA religue varreduras cerimoniais junto dele.** Toda task
   abaixo tem que conviver com o fast-lane, não substituí-lo.
5. **Runtime de missão**: dados vivos de missão estão em `project-runtime/*/runtime.sqlite3`
   (não no `nexus.db`). Para diagnóstico de campo, leia o sqlite certo.
6. **Testes de pane**: SIGKILL = crash (para testar mortalidade), SIGTERM = teardown limpo.
   O `session-mortality-reconciler` sintetiza exit perdido — não colapse "não sei" em
   "morto" (doutrina do `session-liveness.ts`).
7. **Skills de squad no Nexus**: só nomes do vocabulário revisado em
   `src/main/orch/guided-squad-skills.ts` (`NEXUS_GUIDED_SKILL_ORDER`) podem ser
   atribuídos automaticamente. Skill nova = entrada nesse array + revisão.
8. **Commits**: um por task/finding, mensagem `feat(...)`/`fix(...)` no padrão do repo
   (ver `git log --oneline -15`). Atribuição desativada — sem Co-Authored-By.

---

## 2. Mapa fonte → alvo (onde está cada coisa)

| # | Item | Fonte (clonada, legível) | Alvo no Nexus | Status |
|---|------|--------------------------|---------------|--------|
| T1 | Lease registry (startKey) | sem código — doutrina no dossiê §3 | `src/main/pty/pty-manager.ts`, `src/main/pty/session-mortality-reconciler.ts` | **a fazer (P0)** |
| T2 | Warm pool | sem código — doutrina no dossiê §2 | módulo novo `src/main/pty/warm-pool.ts` + `pty-manager.ts` | **a fazer (P0)** |
| T3 | Delta do handoff mecânico | `extract/handoff-deliver.mjs`, `extract/handoff-stop.mjs` | `src/main/orch/turn-end-handoff.ts` | **a fazer (P1, pequeno — ver §3.3)** |
| T4 | Doutrina qa-swarm | `extract/resources/qa-swarm/**` (5 agents + PLAYBOOK) | preset/doutrina em texto + squads | **a fazer (P1)** |
| T5 | Contrato qa-vision | `extract/resources/qa-vision/**` (3 agents + PLAYBOOK) | agents do usuário JÁ EXISTEM em `~/.claude/agents/qa-*.md`; falta o contrato | **a fazer (P1, parcial)** |
| T6 | Semântica `allowedSkills` | `extract/resources/squad-former/skills/overclock-squad-team-assembly/SKILL.md` | `src/shared/orch-types.ts:118`, `src/main/orch/agent-plugin-skill-mirror.ts` | **verificar + fechar (P1)** |
| T7 | Tools MCP (recipes, vault…) | **schemas exatos em `extract/sidecar-tools-runtime.json`** (57 tools extraídas em runtime) + `extract/arms-mcp/**` | `src/main/orch/mcp-server.ts`, `src/main/mcp-hub/` | a fazer (P2) |
| T8 | Pipelines absurd-landing / cinema-site | `extract/resources/absurd-landing/**`, `extract/resources/cinema-site/**` | presets em texto | a fazer (P2) |
| T9 | Gaps pty:* + overdrive | dossiê §10 | `src/main/pty/` | avaliar (P3) |

**Já portado — NÃO REFAZER**: conector Arms (commit `c2ec961b`, com timeouts 8s/120s e
servidor offline de 1 tool), hibernação de grid grande (`68a2f355`), C-194.1 base
(`52c59f08`), Via Rápida (`mission-fast-lane.ts`), Squad Editor + forge-registry (0.16.7),
herança overclick (0.61.0).

**Já coberto pelo `turn-end-handoff.ts` atual** (verificado em código — não re-implemente):
payload primário F-355 (`payloadReplyText`), 5 dialetos de CLI (`last_assistant_message`,
`last_agent_message`, `last-assistant-message`, `prompt_response`…), dedup de re-disparo
por fronteira de turno + impressão djb2, F-339 (input do operador), regra 280/60.000
(verbatim inteiro vs VERDADE+ponteiro), prefixo `[auto]`, skip nomeado por motivo.

---

## 3. As tasks

### T1 — Lease registry / startKey (P0, ataca o pane-fantasma)

**O problema**: race de kill. O Overclock emite um `startKey` no spawn; qualquer kill de
pane precisa apresentar o startKey vivo daquele lease. Kill sem lease ou com lease
divergente é RECUSADO com motivo nomeado ("refuse kill (no startKey on lease)" /
"refuse kill (startKey/live mismatch)"). Um reaper fecha leases órfãos.

**Fontes**: dossiê §3 (doutrina completa). Não há código-fonte legível — o mecanismo vive
no `index.jsc` (bytecode V8) do Overclock; os motivos de recusa foram confirmados por
strings. **Reimplemente o padrão, não tente traduzir código.**

**Alvo**:
- `src/main/pty/pty-manager.ts` — `spawnSession` (~:980), `spawnAgentSession` (~:1199),
  `killSession` (~:2704), `killSessionsFor` (~:2719), `orchKillSession` (~:2797).
- `src/main/pty/session-mortality-reconciler.ts` — o reaper que já existe; o lease
  registry deve alimentá-lo, não substituí-lo.

**O que fazer**:
1. Módulo novo `src/main/pty/session-lease-registry.ts`:
   - `issueLease(sessionId, { kind })` no momento do spawn físico → retorna `startKey`
     (string opaca, ex. djb2 de sessionId+bornAt). Guarda `{ sessionId, startKey,
     bornAtMs, kind }` em mapa no main (persistência não é obrigatória na v1; lease é
     estado de runtime, não de missão).
   - `authorizeKill(sessionId, startKey)` → `{ ok: true }` |
     `{ ok: false, reason: 'no startKey on lease' | 'startKey/live mismatch' }`.
     Chame ANTES de qualquer kill físico/`orchKillSession` de orquestração.
   - `reapStaleLeases(maxAgeMs)` → devolve leases expirados para o
     mortality-reconciler condenar (respeitando: ausência confirmada em N probes,
     período de graça, resposta nula nunca condena).
   - `inspectLease(sessionId)` → diagnóstico (para tool/IPC de inspeção).
2. `killSession`/`orchKillSession` chamam `authorizeKill`; recusa vira log nomeado +
   skip do kill (não erro jogado — a recusa É o comportamento correto contra race).
   Kill com origem no operador humano (fechar aba) pode BYPASSAR com flag explícita
   `force: true` — o humano sempre pode matar.
3. Spawn emite o lease junto do grant que já existe (`spawn-authority.ts`,
   `mission-worker-spawn-authority.ts` — leia-os antes para não criar autoridade dupla;
   o startKey é a prova física do spawn, não uma segunda permissão).
4. IPC/tool de diagnóstico: `inspectLease` exposto como tool MCP de orquestrador
   (padrão das tools em `src/main/orch/tools-handoff.ts`) e como handler IPC
   (padrão `orch-ipc.ts`).

**Testes** (novo `src/main/pty/session-lease-registry.test.ts` + casos nos testes
existentes de pty-manager):
- kill com startKey correto mata; sem startKey recusa com motivo nomeado;
- startKey de lease antigo (respawn físico) recusa mismatch;
- reaper não condena com probe nulo (unverifiable);
- force humano mata mesmo com lease divergente.

**Pronto quando**: um teste que simula a race de campo (spawn novo emite novo startKey
enquanto um kill antigo chega atrasado) prova que o pane vivo NÃO morre e o log nomeia
a recusa. Telemetria: contadores de recusa por motivo (ver `src/main/perf/` para o
padrão de emissão de métricas).

---

### T2 — Warm pool de panes (P0, ataca o cold-start 8-18s)

**O problema**: spawn frio de CLI custa 8-18s. O Overclock mantém um pool de sessões
pré-spawnadas (env `OVERCLOCK_WARM_POOL_SIZE`) com: `take` que **retargeta durante o
boot** (a sessão já boota com o CLI alvo enquanto a missão ainda decide), `evictStale`
por `bornAt`/`maxAgeMs`, reposição **CPU-aware** (só repõe com folga de CPU — o log
deles diz "reposição adiada folga=") e métricas `hits/misses/readyCount/minHeadroom/
skippedByCpu`.

**Fontes**: dossiê §2. Sem código-fonte legível (mesma situação do T1 — reimplemente).

**Alvo**: módulo novo `src/main/pty/warm-pool.ts`; integração em
`pty-manager.ts:spawnSession` e no caminho de spawn de worker do fast-lane
(`src/main/orch/mission-fast-lane.ts` — ache o ponto onde ele pede pane de worker).

**O que fazer**:
1. `warm-pool.ts` com a superfície do Overclock:
   - `NEXUS_WARM_POOL_SIZE` (env, default 0 = desligado — feature-flag de safety);
   - `take(kind: cli)`: devolve sessão pronta se houver (hit), senão spawn normal
     (miss) — e **retarget-durante-boot**: a sessão do pool boota com o CLI default e,
     quando o `take` pede outro CLI compatível, o retarget acontece antes do primeiro
     prompt, não depois do boot completo. Se o retarget não for barato no seu spawn,
     deixe o pool por CLI (pool chaveado por `cli`) e documente a diferença.
   - `evictStale()`: sessão com `now - bornAt > maxAgeMs` (default 10min) é descartada
     e reposta em background;
   - reposição CPU-aware: meça `os.loadavg()`/`cpus()` antes de repor; sem folga →
     adiada com log nomeado ("reposição adiada folga=");
   - métricas: `hits`, `misses`, `readyCount`, `minHeadroom`, `skippedByCpu` — emitidas
     pelo padrão de telemetria do repo (`src/main/perf/`).
2. Integração: o caminho de spawn de worker consulta `take()` ANTES de `spawnSession`.
   O spawn físico continua sendo o de sempre — o pool é cache na frente, não substituto.
3. Hibernação de grid (`68a2f355`) é o complemento: pool aquece o spawn, hibernação
   esconde panes idle. Eles convivem.

**Testes** (novo `warm-pool.test.ts`):
- take com pool vazio = miss + spawn normal (não trava);
- take hit devolve sessão sem novo spawn (espião no spawnSession);
- evictStale não devolve sessão velha;
- reposição adiada quando loadavg alto (mocke `os.loadavg`);
- pool size 0 = zero spawn extra (feature flag desliga tudo).

**Pronto quando**: telemetria mostra hits>0 em missão real de dev, e o cold-start
medido de um worker comum cai visivelmente. **Sem telemetria não é feito** — o fracasso
anterior dessa área foi "sucesso sem prova" (memória da campanha 0.26).

**Armadilha**: o Overclock mantém pool de sessões CLI nuas. Sessão do Nexus tem gate
ctx/rosto de missão — o `take` precisa devolver algo aceitável pelo
`mission-worker-spawn-authority`. Se acoplar demais, prefira pool de PTYs crus
(antes do handshake de agente) e meça só o ganho de boot de processo.

---

### T3 — Delta do handoff mecânico (P1, PEQUENO — o grosso já existe)

**O que já está pronto** (não refaça): ver lista no §2. O que o 1.3.18 tem e o
Nexus não:

**Fonte**: `extract/handoff-deliver.mjs` (twin não-Claude do hook de Stop) e
`extract/handoff-stop.mjs`. Leia os dois — a regra deles é "se um lado mudar, o outro
muda junto".

**Alvo**: `src/main/orch/turn-end-handoff.ts` (+ testes em
`turn-end-handoff.test.ts` / `turn-end-handoff-flow.test.ts`).

**Deltas a portar**:
1. **Attach mode (C-194.3 protocolo)** — `handoff-deliver.mjs` ~"protocol dedup":
   quando o modelo JÁ submeteu handoff por tool neste turno, o hook não re-submete;
   ele **atacha o texto integral no handoff existente** (`attach: true`, summary
   `'-'`) em vez de só pular. Hoje o Nexus (`handoffsSinceTurnStart > 0` → skip)
   pula sem enriquecer. Porte o enriquecimento: no skip por submissão do modelo no
   turno, se o texto colhido é >280 e o handoff existente não tem `fullText`, anexe
   (`artifacts[0].fullText`, teto 60k — mesmo teto de `tools-handoff.ts:71`).
2. **Condense flow (OPCIONAL — decida com o dono do repo)** — o Overclock 1.3.18, em
   resposta >280, PERGUNTA ao worker ("Condense sua resposta anterior em 1 a 2 frases…")
   via pane_write com timeout 60s, e tem três guardas: marcador
   `handoff-condense-<paneId>.txt` (re-dispatch guard), h-hk (pane_write com
   `ok:false` = pergunta nunca apareceu → cai no aviso de tamanho, nunca silêncio),
   h-hr (falso negativo → re-checar handoff_list; se não está pending, a condensação
   venceu → retorno silencioso). O Nexus hoje entrega VERDADE+ponteiro SEM perguntar.
   Essa é uma escolha de comportamento legítima; o valor do condense é summary curto
   de verdade para o orquestrador consumir. Se portar: cole na decisão do
   `buildMechanicalHandoffPayload`, com os três guardas E o sufixo
   `[resumo — íntegra de N chars no registro]`.
3. **F-352 detached bootstrap** — só se um dia o hook virar processo separado que
   precisa sair vivo do Stop. Hoje o hook fala com o main por HTTP
   (`hook-status-endpoint.ts`) — não portar agora.

**Pronto quando**: teste demonstra o attach sem duplicata de handoff (mesma sessão,
Stop re-disparado após submit do modelo → UM handoff, com fullText). Os skips
continuam nomeados (o log é o diagnóstico de campo).

---

### T4 — Doutrina qa-swarm (P1, port de TEXTO — nenhum código do Overclock)

**Fontes** (leia tudo, é pouco):
- `extract/resources/qa-swarm/PLAYBOOK.md`
- `extract/resources/qa-swarm/agents/qa-swarm-{worker,reviewer,scout,observer,builder}.md`

**O que é**: um squad de QA de 3 níveis de pane (L0 orquestrador-chef, L1
sub-orquestradores por função, L2 workers) + 1 tier de workflow. As regras que
FAZEM o sistema funcionar (portá-las é portar a doutrina, não os nomes):

1. **1:1:N** — um chef L1 por FUNÇÃO, escolhido por paneId lembrado (nunca broadcast).
2. **Workflow roda SEMPRE no L2** — o worker que recebe `/workflow` roda o swarm NO
   PRÓPRIO PANE; o sub-orq fica livre (worker busy ≠ sub-orq busy). No Nexus: quem
   abre workflow em worker é o worker, nunca o chef.
3. **Gate de decisão NÃO-discricionário no sub-orq** — "worker opus com discrição
   SEMPRE grinda o problema"; o L1 decide com gate mecânico (formato do handoff,
   contagem de findings, evidência), não com opinião do worker.
4. **allowedSkills vincula o WORKER, nunca o chef** — a skill é do executor.
5. **Completion check via registro** — chef confere `handoff_list` (registro), NUNCA
   `pane_read` no TUI vivo (leitura de TUI mente).
6. **END YOUR TURN** — toda instrução de worker termina com "END YOUR TURN"
   (turn não terminado = workoff não fecha).
7. **Handoff com evidência obrigatória** — artifacts = findings com file:linha ou
   hash de commit + resultado de tsc/test; "artefato vazio = re-invocação".
8. **Hard file-owner** — 1 commit por finding ID, `git add` específico, nunca `-A`.
9. **Inglês nos sub-prompts** em todo nível (tokens e precisão).
10. **Cada nível fecha seus filhos** — sub-orq fecha workers, chef fecha sub-orqs.

**Alvo**: como o Nexus já tem squads (`src/shared/orch-types.ts` schema Squad, Squad
Editor) e agents do usuário, o port é: (a) um PRESET de squad QA no formato do repo
(veja como presets existentes são declarados — procure por preset/squad em
`src/main/orch/`), com roles mapeadas para agents do catálogo; (b) as regras 1-10
acima na `orchestratorInstructions` do preset e nas instructions de cada role;
(c) se alguma regra precisar de código (ex.: garantir que workflow abre no pane do
worker), um gate pequeno no caminho de spawn — mas comece só com texto; a doutrina
dirige o modelo.

**Teste**: não há teste unitário de doutrina. Pronto quando um reviewer lê o preset
e confirma as 10 regras presentes e não-contraditórias com `NEXUS_GUIDED_SKILL_ORDER`
(skill nova que você citar precisa estar no array — regra §1.7).

---

### T5 — Contrato qa-vision (P1 — agents já existem, falta o CONTRATO)

**Estado atual**: os três agents do qa-vision JÁ estão em `~/.claude/agents/` do
usuário (`qa-navegador-visao`, `qa-resolvedor`, `qa-reviewer-estatico`). O que NÃO
foi portado é o mecanismo de contrato:

**Fontes**: `extract/resources/qa-vision/PLAYBOOK.md` + os 3
`extract/resources/qa-vision/agents/*.md` (compare com os instalados — sincronize
qualquer delta de doutrina).

**A mecânica do contrato** (o que importa):
1. **1 arquivo F-XXX.md por bug** — NUNCA um ledger único. "O estado da operação
   vive NO CONTRATO": worker morre sem perda porque cada finding é um arquivo fechado.
2. **Faixas de ID por reviewer** (ex.: estático 100-199, navegador 200-299,
   resolvedor 300+ ou por faixa de cluster) — sem colisão de ID entre workers.
3. **1 commit por finding** com o ID na mensagem.
4. **Fan-out por cluster de arquivo** — bugs no MESMO arquivo vão pro MESMO
   resolvedor (clustering antes do dispatch).
5. **Hub**: painel de bugs em `http://127.0.0.1:7788/tasks?filter=bugs` (no Nexus,
   o board já existe — o hub é o board filtrado; NÃO suba um servidor novo).
6. **Precisa-decisão → usuário imediatamente**; worker stalled >10min → conferir
   `handoff_list` e re-spawn.

**Alvo**: (a) sync dos 3 agents em `~/.claude/agents/` com os do extract (diff e
aplique só o que for doutrina); (b) o contrato como skill/preset no vocabulário do
repo (lembrando §1.7 — se virar skill Nexus, entra em `NEXUS_GUIDED_SKILL_ORDER`);
(c) estado do contrato no formato do repo (arquivos markdown no workspace da missão —
mesma ideia dos markers do fast-lane).

**Pronto quando**: um ciclo simulado (3 findings de 2 arquivos) produz 3 arquivos
F-XXX.md com IDs em faixas corretas e 3 commits, sem ledger central.

---

### T6 — Semântica `allowedSkills` (P1 — verificação + fechamento)

**O que o Overclock ditou** (fonte:
`extract/resources/squad-former/skills/overclock-squad-team-assembly/SKILL.md`):
- `allowedSkills` POPULADO = hard gate (só aquelas skills);
- OMITIDO = irrestrito;
- **`[]` (array vazio) QUEBRA** — vazio é "nada permitido", não "tudo";
- skill cross-CLI é ESPELHADA no spawn para o dir de skills do CLI daquele agent, e o
  preview do gate TEM que dizer ("frontend-design (claude → mirrored to codex)").

**Estado no Nexus** (verificado): `src/shared/orch-types.ts:118` —
`allowedSkills: z.array(...).nullable().optional()` com comentário
"null/absent = unrestricted" — a semântica documentada JÁ bate. Falta VERIFICAR:
1. o enforcement no spawn trata `[]` como hard gate (nada permitido) e não como
   irrestrito — ache onde allowedSkills é consumido (comece por
   `src/main/orch/spawn-authority.ts`, `agent-plugin-skill-mirror.ts`,
   `mission-worker-spawn-authority.ts`);
2. o espelho cross-CLI no spawn existe (`agent-plugin-skill-mirror.ts`) — confira se o
   PREVIEW do gate nomeia a origem e o destino do espelho.

**O que fazer**: testes de mesa+vivo para `[]` vs omitido vs populado; se `[]` estiver
sendo tratado como irrestrito, é BUG de segurança de autoridade — corrija com teste.
Doc da semântica no comentário do schema (já quase lá).

**Pronto quando**: `vitest run` tem casos nomeando os três estados e o comportamento
bate com a tabela acima.

---

### T7 — Superfície MCP (P2)

**Fontes**: dossiê §8 (**57 tools em runtime**, schemas exatos em
`extract/sidecar-tools-runtime.json` — extraídas por introspecção viva do sidecar
bootado standalone e validadas contra o app real, diff zero) +
`extract/arms-mcp/**` para o formato de definição de tool.

**Alvo**: `src/main/orch/mcp-server.ts`, `src/main/mcp-hub/`, e o padrão de tools em
`src/main/orch/tools-handoff.ts`.

**Prioridade dentro da task**: (1) **recipes** (payloads de prompt reutilizáveis);
(2) **vault** (se não colidir com o que já existe em `src/main/memory/`); (3) o resto
conforme demanda. **Cron NÃO existe em runtime no Overclock** — as 3 tools cron são
código dormente que não registra nem no app real (dossiê §8, "tools fantasmas");
portá-las é inventar feature nova, não paridade — só fazer se o Nexus quiser cron de
verdade. `perf_events` consumível pelo agent é a joia escondida: o agente lê as
próprias métricas de runtime para se auto-diagnosticar.

Cada tool nova entra no vocabulário permitido (não deixe bypass de autoridade).
Tools de orquestrador seguem o padrão de gate de papel que já existe.

---

### T8 — Pipelines absurd-landing / cinema-site (P2, port de TEXTO)

**Fontes**: `extract/resources/absurd-landing/PLAYBOOK.md`,
`extract/resources/cinema-site/PLAYBOOK.md` (+ `extract/resources/cinema/` para
referência). Doutrinas-chave: pipeline FIXO com gates por etapa (o modelo não escolhe
a ordem), rota de FAIL vai pro OWNER da camada culpada com CAP de 1 redo, RED LINE
brief = intenção não execução.

**Alvo**: presets em texto no repo (mesmo formato que você escolher no T4). Um
pipeline é uma sequência de gates declarada — no Nexus, olhe como o fast-lane declara
etapas antes de inventar formato novo.

---

### T9 — Gaps pty:* e overdrive (P3 — só avaliar)

- `pty:readRawTail`, `pty:replay`, `pty:resync`, `pty:readSerialized` (dossiê §10):
  leituras que o Nexus não expõe. Avalie custo/benefício por sintoma real — não porte
  por paridade.
- **overdrive** (Rust-side control plane, panes mirrorless): a hibernação de grid
  (68a2f355) já cobre a dor principal. Só reabra se um caso de campo aparecer.

---

## 4. Ordem sugerida e dependências

```
T1 (lease)  ──► T2 (warm pool)     [ambos no pty; lease primeiro: menor e mata o pane-fantasma]
T6 (allowedSkills) ──► T4, T5      [semântica verificada antes de montar squads que dependem dela]
T3 (handoff delta)                 [independente; pode rodar em paralelo com qualquer um]
T7, T8                              [depois dos P0/P1; T7 começa pelas recipes — cron é dormente]
T9                                  [opcional, por demanda de campo]
```

Regra de ouro: **uma task por PR/commit destrinchável**, telemetria ou teste provando
o efeito (a lição da campanha 0.26 foi "sucesso sem prova" — não repita).

## 5. Diagnóstico de campo quando algo quebrar

- Missão travada/blocked: leia `project-runtime/<workspace>/runtime.sqlite3`
  (tabela/fila `task_dispatch_queue`, coluna `last_error`) — não o `nexus.db`.
- Pane fantasma: `session-mortality-reconciler` + logs de liveness; depois do T1,
  logs de recusa de kill nomeiam a race.
- Handoff não fechou: os skips são nomeados por motivo — procure
  `[turn-end-handoff]` no log antes de teorizar.
- Release: `NO_COLOR=1` no gate de fuses (FORCE_COLOR do shell reprova release boa);
  `make:release` exige o Node exato do `check-build-node.mjs`.

## 6. Referências

- Dossiê completo: `docs/analysis/overclock-13318-dossie-portabilidade.md` (§2 warm
  pool, §3 lease, §4 handoff, §5 qa-swarm, §6 qa-vision, §7 squads, §8 tools, §12 roadmap)
- Fonte clonada: `docs/analysis/overclock-13318-extract/` (101 arquivos; `arms-mcp/`
  e `resources/` são legíveis; `handoff-*.mjs` são JS puro)
- Blueprint da versão 1.3.4 (contexto histórico dos schemas pane_spawn/handoff):
  memória `overclock-reverse-engineering-blueprint`
- Limitação honesta: warm-pool/lease/overdrive foram confirmados por strings do
  `index.jsc` (bytecode), não por fonte — por isso T1/T2 são reimplementação de
  doutrina, não tradução de código.

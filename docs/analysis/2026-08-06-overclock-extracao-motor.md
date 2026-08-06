# Extração do motor do Overclock — evidência de disco, não inferência

**Data:** 2026-08-06 · **Autor:** pane-248 · **Status:** análise; commit só depois da 0.27.0
**Fontes lidas verbatim:** `~/.overclock-app/handoff-deliver.mjs` (430 linhas),
`~/.overclock-app/handoff-stop.mjs` (34KB), `.agents/hooks.json`,
`~/.overclock-app/mcp-config.json`, `mcp-pane-*.json`, listagem do dir.
Cópias preservadas neste diretório (`overclock-handoff-*.mjs.txt`).

---

## 0. A descoberta

**Os hooks são arquivos `.mjs` legíveis.** Passamos a semana inferindo o
substrato; ele está em disco, comentado, com medições de campo datadas. O que
segue é o mecanismo REAL, não mais reconstrução.

Ligação (project-level, `.agents/hooks.json` — o arquivo que gitignoramos):
```json
{"overclock-handoff-deliver":{"enabled":true,"Stop":[{"type":"command",
 "command":"…/sidecar/bin/node …/.overclock-app/handoff-deliver.mjs","timeout":5}]}}
```
Dois scripts: `handoff-stop.mjs` (família Claude) e `handoff-deliver.mjs`
(codex/gemini/grok/opencode/antigravity). Dois eventos: `Stop` e
`UserPromptSubmit`.

---

## 1. Os 12 mecanismos (todos EVIDENCIADOS)

| # | Mecanismo | Evidência | Nexus hoje |
|---|---|---|---|
| **H1** | **Execução DESACOPLADA (F-352)**: o processo que o CLI espera não faz I/O de rede — grava o payload, relança a si mesmo `detached` (`OVERCLOCK_STOP_CHILD=1`) e sai **exit 0 em ms** | `runDetached()`, deliver:400-430 | **Nosso `HOOK_SCRIPT` é síncrono e fail-closed** — é exatamente a razão documentada de não o instalarmos no HOME real (`0fe423aa`). **Este é o destravamento.** |
| **H2** | **Fechamento mecânico**: se o modelo não submeteu, o hook submete por ele — `summary:'[auto] '+body`, `closedBy:'deliver-hook'`, `to: CALLER` | deliver:380-405 | Temos equivalente app-side (`b9739896`), que alcança **todos** os CLIs — onde o hook do Overclock não alcança |
| **H3** | **Nag DIFERIDO e limitado**: falha do auto-handoff grava `handoff-fail-<pane>`; o **próximo** Stop (custo = um `existsSync`) escreve no stderr e `exit(2)`. Cap de 2 seguidas; o Stop provocado volta com `stop_hook_active=true` e o pai sai 0 | stop:44-60 | Não temos. Nosso bloqueio é imediato e sem cap explícito no cliente |
| **H4** | **Ensino INVISÍVEL > erro visível**: `decision:block` pinta "Stop hook error" na TUI e foi **REPROVADO pelo dono (2026-07-26)**. O canal certo é `UserPromptSubmit`: injeta contexto que só o modelo vê, zero pixels | stop:520-536 | Temos `UserPromptSubmit` só para status; não ensinamos por ele |
| **H5** | **Regra dos 280 chars + auto-pergunta**: resposta >280 → guarda a íntegra e **escreve uma pergunta natural no próprio pane** ("Condense sua resposta anterior em 1 a 2 frases"); o turno curto seguinte fecha verbatim levando a íntegra como `fullText` | deliver:300-345 | Não temos. É a origem da instrução de 280 chars que os workers recebem |
| **H6** | **Anti-eco em cadeia (F-342)**: regex `^<channel …via="overclock"` detecta turno iniciado pela entrega de OUTRO pane e **suprime o submit** | deliver:26-30, 140-152 | Não temos — não temos entrega-em-cadeia ainda |
| **H7** | **Dedup por IDENTIDADE DE TURNO**, nunca heurística de tempo: claim file com flag `wx` | deliver:250-270 | Temos idempotência por chave; equivalente |
| **H8** | **Dedup pelo PROTOCOLO**: pergunta `handoff_list` se a ficha ainda está `pending`; terminal ⇒ o modelo já fechou, só **anexa** a íntegra | deliver:290-310 | Equivalente no store |
| **H9** | **Origem humano×sistema**: arquivo `input-origin-<paneId>` escrito na fronteira do IPC (`pty:write`=humano, `pane_write`=sistema). Turno digitado pelo humano **nunca** entrega | deliver:22-26 | **Não temos** — e é a peça que evita acordar o chefe com conversa do operador |
| **H10** | **fail-open deliberado**: transcript ausente/desconhecido ⇒ entrega assim mesmo. *"eco a mais é ruído; resultado perdido é o bug que este mecanismo conserta"* | deliver:130-140 | Nosso é fail-**closed** — a escolha oposta, e a razão de não termos ligado |
| **H11** | **Guarda de identidade**: sem `paneId`, sem `CALLER`, ou `CALLER===paneId` ⇒ `exit 0`. Pane livre do humano e CLI fora do Overclock (que herdou o hook do arquivo compartilhado) nunca reportam | deliver:8-10 | N/A |
| **H12** | **MCP por pane**: `mcp-pane-<id>.json` com `url` SSE carregando `model`, `providerId`, `missionId`, `callerPaneId` na query | `mcp-pane-*.json` | Temos `--mcp-config` por sessão; equivalente |

### A lição central (H1 + H10)

O nosso Stop do gate não foi instalado no caminho padrão **porque é síncrono e
fail-closed**: gate indisponível ⇒ worker não consegue encerrar. O Overclock
resolve o MESMO problema com duas escolhas que podemos copiar hoje:
**(a) desacoplar** (pai sai em ms, neto faz a rede) e **(b) fail-open no `stop`**
(nunca no `pretool`). Isso fecha o furo de `0fe423aa` sem o risco que nos travou.

---

## 2. Paralelismo é DECLARADO, não inferido (ATESTADO pelo orquestrador)

Consultado ao vivo via as tools de introspecção do próprio Overclock.

**Recipes** trazem a forma de fan-out no texto:
- site-mvp "CINEMA SITE" → *"modo acelerado, **pico 9 panes**"*
- app-mvp "APP FACTORY" → *"**fan-out por tela**, gates entre fases, handoffs H1-H5"*
- saas-mvp → *"auditoria OWASP **por superfície**"*

**`orchestratorInstructions` dos squads** declaram a estrutura com `∥` e gates:
- app-factory: *"contrato de dados ANTES do build → back ∥ front (**1 worker por tela**) → integrador → QA **1 verificador por fluxo**"*
- cinema-site: *"intake → direção (DNA ∥ copy ∥ ref) → gate H2 → build + imagens ∥ → review 3 lentes"*
- autopilot: *"**1 scout por fonte** → gate na amostra REAL"*
- saas: *"auth ∥ dados ∥ billing, auditor nunca conserta"*

**Conclusão que muda o plano:** o Overclock não abre 9 panes porque um planner
*descobriu* independência num objetivo qualquer. Abre porque **o workflow
DECLARA a forma**. Inferência é o caminho difícil e frágil; declaração é o
caminho confiável — e é portável hoje.

---

## 3. Prong (a) no modelo de plano do Nexus — **o socket já existe e está VAZIO**

`src/shared/wave-pack-templates.ts` já tem exatamente essa maquinaria:
`WAVE_PACK_TEMPLATE_IDS = ["landing","saas","fix"]`, com `stories[]` por template
e `storiesForWavePackTemplate()` alimentando `planWavePackTasks`.

**O buraco, medido:** `WavePackTemplateStory` = `{id, epicStoryId, title, body}` —
**nenhum `ownershipFiles`** (0 ocorrências no arquivo). E em
`mission-wave-pack.ts:466-470` o modo disjunto só engata quando **TODAS** as
stories declaram `ownershipFiles`; senão, todas herdam o `baseOwnership`
compartilhado e **colapsam numa unidade lógica**.

> Ou seja: o Nexus já tem templates declarativos, e eles **não abrem em leque**
> porque as stories não dizem que arquivos possuem.

**A mudança de prong (a) é pequena e cirúrgica:**
1. `WavePackTemplateStory` ganha `ownershipFiles: readonly string[]`.
2. Cada story dos 3 templates declara sua fatia disjunta
   (`saas` → `auth ∥ dados ∥ billing` é literalmente o exemplo do Overclock).
3. Nada mais muda: `planWavePackTasks` já emite raízes paralelas, o scheduler já
   admite N disjuntos (`selectDisjointWave`), leitores já não tomam slot
   (`347f0b7b`), e o caminho simples já conclui sem worktree (`24b55bd4`).
4. Templates novos por forma de objetivo ("1 worker por tela", "1 scout por
   fonte") entram como dados, não como código.

**Por que isto é o que põe 8 panes na tela dele:** todo o motor a jusante já foi
consertado esta semana. O que falta é **declarar a forma** — e o lugar de
declarar já está construído.

---

## 4. Doutrina de modelo/effort (ATESTADO) — e o turno 1 de 26 minutos

Três faixas: **rápido/barato** para "mecânico e repetitivo: grep, lookup, recon
em massa"; **equilibrado** como padrão; **profundo/caro** só para
"design-defining: o contrato compartilhado, o traço difícil entre arquivos, a
costura que todos consomem". Effort por **profundidade-de-raciocínio-por-turno,
não por importância**, com a regra: **"default DOWN, escalar UP só com razão
concreta"**.

Heterogeneidade DENTRO de um squad é deliberada: opus+high no assento que define
o design, defaults no resto.

**Aplicação direta:** o turno 1 do orquestrador dele levou ~7min em Opus/xhigh só
para selar o plano. Pela doutrina do próprio Overclock, exploração de
planejamento é faixa baixa; o teto se reserva para o momento que define o
contrato. **Recomendo NÃO mexer em default sem medir** — parte daqueles minutos
era espera de CI real, que modelo nenhum encurta (medido hoje).

---

## 5. O que NÃO copiar (observado esta semana)

monocultura de CLI em squad; `width_cap` contando pane morto até recusar a
própria recuperação; fantasmas de TTL exigindo purge+resume; avisos falsos de
morte; ausência de `pane_list` para o próprio piloto.

---

## 6. Ordem recomendada (revisada por esta extração)

| # | Item | Tamanho | Por quê |
|---|---|---|---|
| 1 | **`ownershipFiles` nos templates de wave-pack** | **P** | Socket pronto; é o que abre a tela dele |
| 2 | Templates novos por forma ("1 por tela", "1 por fonte") | P–M | Dados, não código |
| 3 | Stop desacoplado + fail-open no `stop` (H1+H10) | M | Fecha o furo de `0fe423aa` sem o risco que nos travou |
| 4 | `input-origin` humano×sistema (H9) | P | Evita acordar o chefe com conversa do operador |
| 5 | Ensino por `UserPromptSubmit` (H4) | P | Zero pixels, chega no turno certo |
| 6 | Inferência para objetivo livre (prong b) | G | Só depois; conservador, com veredito explicando quando serializa |

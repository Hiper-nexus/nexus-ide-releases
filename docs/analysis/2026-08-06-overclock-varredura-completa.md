# Varredura completa do Overclock — parte 2 (fecha a extração)

**Data:** 2026-08-06 · pane-248 · análise; nada escrito no repo Nexus.
Marcação: **OBSERVADO** (li em disco) · **ATESTADO** (orquestrador puxou ao vivo)
· **INFERIDO** · **ILEGÍVEL** (bytenode — nunca afirmar que lemos).

---

## ⚠️ CORREÇÕES ao que acreditávamos

### C1 — O modelo NÃO é plano. É hierárquico de 3 andares. **[OBSERVADO]**
Fonte: `~/.overclock-app/system-prompt-pane-105.txt` (127 linhas, texto puro —
é o prompt injetado no pane do ORQUESTRADOR, e contém blocos que **não** existem
no prompt de um pane worker como o meu).

> *"ROUTE BY CHEFE-TIER (hard — C-081 7c): the topology is 3 FIXED chefes,
> scout/builder/reviewer, and each chefe runs ONLY the workers of its OWN tier."*

`pane_spawn({ chefe: "scout" | "builder" | "reviewer" })`. Ou seja:
**orquestrador → 3 chefes de tier → workers folha**. Eu vinha modelando
orquestrador → workers (2 andares). São **3**.

Consequências que mudam nosso plano:
- o "pico 9 panes" das recipes é **produto da hierarquia**, não de um leque
  único: cada chefe abre os workers do seu andar;
- há **regra de blocos**: passos que atravessam papéis são agrupados em blocos
  contíguos do MESMO papel, **um `pane_spawn` por bloco**, sequenciados por
  handoff ("never fire the next block before the previous one's handoff arrives");
- recipes têm `spine[].role` — a forma do leque é **dado com papel**, não prosa.

### C2 — O "width cap" é ≤5 workers folha, declarado. **[OBSERVADO]**
> *"fans out the oc-cataloger agent (≤5 leaf workers, the width cap)"*

Não é um número emergente: é teto declarado por chefe. Nosso `effectiveCap=8`
por missão é **mais generoso** — a diferença de largura que ele vê vem da
hierarquia (3 chefes × N folhas), não de um teto maior.

### C3 — `system-prompt-pane-<id>.txt` é por-pane e legível. **[OBSERVADO]**
Não é persona secreta: é o append-system-prompt materializado em disco por pane.
O do worker é o que eu já carrego; o do orquestrador tem os blocos extras acima.

### C4 — **Não consegui medir os tempos.** **[OBSERVADO — negativo]**
`messages.db` (2,5MB) é **legado**: `messages` e `tasks` têm **0 linhas**;
`activity_log_v2` tem **1 linha de 2026-07-01**. O volume do arquivo é catálogo
antigo + WAL. **Não há trilha de spawn→handoff→reap em disco.** Os 3-7s continuam
não medidos — e vou continuar dizendo isso em vez de inventar número.

### C5 — Não existe `briefs/`. **[OBSERVADO — negativo]**
A "delegação por ponteiro" que supúnhamos não tem diretório em disco nesta
instalação. Se existe, é campo de tool (`briefId`), não arquivo. **Rebaixar** de
"mecanismo a copiar" para "não confirmado".

---

## ✅ Achado novo de maior valor para o produto

### N1 — **DEGRADAR POR TIER, NUNCA ERRAR** **[OBSERVADO]**
> *"DEGRADE BY TIER, never error: vídeo+img active → hero animado + fotos; só img
> → hero/fotos estáticos; NENHUM → hero CSS/tipográfico… never emit a 'configure
> img primeiro' error; always ship the tier the current keys allow."*

É a doutrina oposta à nossa. O Nexus **bloqueia** quando falta capacidade
(credencial, provider, gate); o Overclock **entrega o melhor tier possível** e
oferece o upgrade *depois*, fora do caminho crítico. Isso é diretamente a classe
de morte que ele sofreu o dia todo — só que na camada de capacidade em vez da de
cerimônia.

### N2 — Copy sem vazar encanamento **[OBSERVADO]**
Lista explícita de palavras proibidas ao usuário: *immersion, scout, cataloga,
stacks, catalog, overlay, workers, recipe, Capabilities*. Só "processo PRONTO" e
"calibrar" são nomes públicos. Nosso produto expõe `handoff_ready`,
`same_checkout`, `PREVC`, `wave-pack` direto na tela.

### N3 — Primeiro resultado nunca depende de calibração **[OBSERVADO]**
"PRE-CALIBRATION — FIRST CONTACT": duas portas, calibração é **escolha, nunca
gate**. Nós fazemos o oposto: bootstrap/PREVC/aprovação antes do primeiro
resultado (o que a 0.27.0 acabou de derrubar).

---

## Estrutura de dados **[OBSERVADO]**
- `providers.json`: `{providers:[{id,label,type,host,env{…},models[],authMode}],
  builtinEnabled{}, builtinModels{}}` — segredos em `env.*_TOKEN` (não impressos).
- `squads.json` (7,6KB), `missions.json` (8,7KB) — presets e missões.
- Hooks extras em disco, além dos dois já extraídos: `soft-status.mjs`,
  `workflow-deny-pane-*.mjs`, `release-gate-pane-*.mjs`, `kimi-mcp-bridge.mjs`
  (ponte MCP dedicada ao Kimi — CLI sem suporte nativo).
- `mcp-pane-<id>.json`: SSE em 127.0.0.1 com `model`, `providerId`, `missionId`,
  `callerPaneId` na query.

## ILEGÍVEL
Bundle JS é bytenode. Schemas completos das tools MCP e a implementação do
sidecar **não foram lidos** — o que temos das tools é o contrato injetado
(ATESTADO), não o código.

---

## Tabela delta — ranqueada por impacto no que ELE vê

| # | Overclock faz | Nexus faz | Mudar para | Impacto |
|---|---|---|---|---|
| 1 | **Degrada por tier, nunca erra** | Bloqueia por capacidade ausente | Entregar o tier possível; oferecer upgrade depois | **Alto** — mata a classe "não consigo começar" |
| 2 | **Hierarquia 3 andares** (orq → chefe → folhas) | 2 andares (orq → workers) | Avaliar chefe-tier; é o que produz "9 panes" | **Alto** — é a largura real |
| 3 | Recipes com `spine[].role` | Templates sem papel e sem ownership | `ownershipFiles` + papel por story (F2) | **Alto** — já planejado |
| 4 | Primeiro resultado sem calibração | Bootstrap antes do resultado | Feito na 0.27.0 | ✅ |
| 5 | Copy sem encanamento | Expõe `handoff_ready`, `same_checkout` | Vocabulário de usuário | Médio |
| 6 | Cap declarado ≤5 por chefe | `effectiveCap=8` por missão | Manter o nosso (melhor) | — |
| 7 | Ponte MCP por CLI (`kimi-mcp-bridge.mjs`) | Overlay governado | Comparar cobertura | Baixo |

---

## O que NÃO mudou de opinião
Os 12 mecanismos de hook do arquivo anterior seguem válidos e são a base do F1
(`stop` desacoplado/fail-open × `pretool` síncrono/fail-closed).

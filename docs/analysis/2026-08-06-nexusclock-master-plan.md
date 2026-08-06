# NexusClock — plano mestre

**Data:** 2026-08-06 · pane-248 · **Encomenda:** *"quero um NexusClock"*
*(v2 — a v1 está em `master-plan-v1-superseded.md`; o enquadramento mudou)*

---

## A TESE

> **O Overclock não vence em superfície. Vence em DOUTRINA.**

Medido, não estimado: **Nexus expõe 146 tools MCP; Overclock, ~35.** Quatro das
seis capacidades que suspeitávamos faltar já existiam. A lista de gaps reais tem
**dois itens e meio**.

O Nexus não é um produto atrasado. É um produto **mais capaz e pior governado**.

Consequência para o plano inteiro: **parar de adicionar capacidade e começar a
impor doutrina.** Cada seção abaixo é uma doutrina com a forma que o **código**
pode cobrar — prosa não sustenta nada.

---

## D1 — NUNCA BLOQUEIE, SEMPRE DEGRADE

Falta de capacidade ⇒ entregar o melhor tier funcionando. Bloquear só quando
**não existe** resultado menor — e aí a mensagem é acionável.

**Origem (lida em disco):** *"DEGRADE BY TIER, never error… always ship the tier
the current keys allow."*

**Por que é a mais importante:** quase toda morte dele hoje foi falta de
capacidade respondida com parede — worktree ausente, PREVC não congelado,
ownership não mapeada, provider de voz ausente. Todas tinham resultado menor.

**Como o código cobra:**
- mapa bloco→tier degradado (19 blocos em `DEGRADAR-NUNCA-ERRAR.md`);
- contrato `missionDegradation {what, reducedTo, why, recoverable}` no mesmo
  journal do veredito de teto;
- **teste de guarda**: allowlist dos bloqueios legítimos (corrupção de topologia,
  violação de autoridade). `throw` novo no caminho da missão fora da allowlist
  **quebra o teste** — quem adicionar declara o tier degradado ou justifica.

---

## D2 — OS DEFAULTS SÃO O PRODUTO

Todo default se justifica por *"o que recebe quem não configurou nada?"*.

**Auditoria pós-0.27.0 (medida em `settings-types.ts`): os defaults passam.**
Zero-config dá `claude`, política **operator-choice**, `fastPath` ligado, driver
ativo, `agentRestorePolicy: resume`, attestation **off**, entrega em
`same_checkout`.

**Resíduos de perícia — todos atrás de opt-in, nenhum no caminho padrão:**
- `acpHarnessId: ''` — trocar transporte para `acp` faz o spawn recusar até
  escolher harness. É bloqueio, não degradação (**candidato a D1**).
- `startCap: 2` — só sob Hardened.

**Como o código cobra:** teste que instancia `DEFAULT_ORCH_SETTINGS` e afirma
que uma missão comum roda ponta a ponta sem tocar em configuração alguma.

---

## D3 — DECLARE O PARALELISMO ONDE PUDER; INFIRA ONDE PRECISAR

- **Declarar (F2):** `wave-pack-templates.ts` já existe e está **vazio de
  ownership** — socket construído e desconectado.
- **Inferir (prong b):** particionar o **inventário vivo** que o planner já lê
  (`guided-mission-planner.ts:482-489`).
- **Teto honesto, medido no repo dele:** HiperGO tem 3 pacotes de código ⇒
  **2 a 4 raízes, tipicamente 3.** Não 8. O limite é a forma do repositório,
  não o motor.

**Como o código cobra:** veredito ganha `serializedByOwnership` para o caso misto.

---

## D4 — MODELO/EFFORT POR FORMA DA TAREFA

Mecânico→barato, normal→equilibrado, define-contrato→profundo. Effort por
**profundidade de raciocínio por turno**. **Default DOWN; escalar UP só com razão
declarada.**

**Contraexemplo:** turno 1 de planejamento no teto (Opus/xhigh).
**Ressalva medida:** parte daquele tempo era **espera de CI real**, que modelo
nenhum encurta. Não mexer em default sem medir.

---

## D5 — GARANTIA NÃO DEPENDE DE BOA VONTADE

- **hook de RELATO** (`stop`) → **desacoplado e fail-open**, para ser instalável
  em toda parte sem risco;
- **gate de AUTORIZAÇÃO** (`pretool`) → **síncrono e fail-closed**; gate
  fail-open não é gate, é convite.

Mais o cinto app-side (`worker-handoff-enforcement`), que alcança CLIs onde hook
nenhum chega — **onde superamos o Overclock**, cujo hook é preso ao Claude Code.

---

## D6 — O SISTEMA SE EXPLICA

Toda redução, serialização, teto, parada ou degradação é visível **com o motivo**.
Foi esta que hoje transformou *"está travado"* em *"está trabalhando"*.

---

## OS 2,5 GAPS REAIS

| # | Gap | Valor | Tamanho |
|---|---|---|---|
| 1 | **`brief` — delegação por ponteiro** | Corta tokens e boot em TODA delegação; briefing vira artefato revisável | M |
| 2 | **`autoCloseOnHandoff` + escopos de close** | Pane entregue para de segurar vaga da onda seguinte | P |
| 2,5 | **Busca de agente/skill ranqueada por necessidade** | Delegar sem despejar catálogo | M |

---

## ATIVOS A NÃO REGREDIR

Simplificar **não pode** apagar capacidade. Quando cerimônia e capacidade estão
entrelaçadas, a capacidade vira **opt-in** — como fizemos com a worktree isolada
(`84110780`): não deletada, e sim escolhível.

`code_map_*` (blast radius), `lsp_*`, 11 tools de git, contexto governado (9),
`design_system_*` (8), memória, worktree + fila de merge, `handoff_ack`,
`agent_invoke`, sensores/segurança/validação, remoto. **O Overclock não tem
equivalente a nenhuma.**

---

## ORDEM

1. **prong (b)** — particionar o repo vivo (1 raiz → N)
2. **D1 degradar** — converte erro em missão que roda
3. **F2 templates** — encher o socket vazio
4. **F1 forma do hook** — garantia em todo CLI
5. *(dormente)* **árvore de tiers** — disparo: `áreas ≥ 2` **e** `unidades > 8`

**Duas lições pagas caro hoje:**
1. **Subir `maxWorkers` nunca foi a correção** — perseguimos teto duas vezes.
2. **A árvore só paga acima do teto que já temos**; construí-la agora seria
   arquitetura a serviço de hipótese enquanto o gargalo real segue intocado.

---

## LEDGER — feito (hashes verificados)

`84110780` worktree opt-in · `10347b0c` argv-at-birth claude ·
`24b55bd4` same_checkout de 1ª classe · `5c0208b9` caminho simples é o padrão ·
`2e24cee3` sem awaiting_approval · `9e432cf0` zero prompts ·
`1990ad1a` poda do gate · `efe44703` panes preservados ·
`0930a7a7` contrato E2E do mundo novo · `574139c5` veredito "N de M" ·
`347f0b7b` leitor sem slot exclusivo · `827273b5` vivacidade por atividade ·
`ca488d18` + `d23ae49c` voz.

# PROMPT COMPLETO — cole isto no Sol (recomendado) ou Fable-5

Repo local: `/Users/cleofaspereirarocha/nexus-ide`  
Branch: `main` · versão **0.19.26** · commit `0e2396b`

---

## Modelo

**Use Sol (GPT Codex / GPT-5.x Sol).**  
Fable-5 só se Sol estiver indisponível. Não rode os dois em paralelo no mesmo `src/main/orch`.

---

## Ordem obrigatória de leitura (faça ANTES de codar)

Leia estes arquivos **nesta ordem**. Não pule.

### Bloco A — mandato e diagnóstico (já escritos pro founder)

1. `docs/analysis/BRIEFING-SOL-FABLE5-O-QUE-CODAR.md`
2. `docs/analysis/DIAGNOSTICO-SENIOR-NEXUS-2026-07-22.md`
3. `docs/analysis/PROMPT-GPT-SOL-NEXUS-ORQUESTRACAO.md` (espelho deste mandato)

### Bloco B — análises internas (RCs e comparativo)

4. `docs/analysis/2026-07-15-analise-senior-orquestracao-overclock-orca.md`
5. `docs/analysis/2026-07-18-analise-senior-nexus-vs-overclock-orca-omp.md`
6. `CHANGELOG.md` (só 0.19.14 → 0.19.26)

### Bloco C — código da Onda 0 (onde você vai mexer)

7. `src/main/orch/task-router.ts` — RC1–RC5, diversity, quality fixture  
8. `resources/model-catalog.json` — quality scores / fixture  
9. `src/main/orch/tools-panes.ts` — `pane_spawn` (enforce RouteReservation aqui)  
10. `src/main/orch/squad-architect.ts` — agentic-fallback vs squad salvo  
11. `src/main/orch/squad-reuse.ts` — identidade de squad  
12. `src/renderer/orch/mission-launcher.ts` — kickoff paste + acceptance  
13. `src/main/orch/idle-delivery.ts` — handoff + prova idle  
14. `src/main/orch/mission-drive.ts` — decisões de drive  
15. `src/shared/mission-intent.ts` — contrato de intenção / lanes  
16. `src/main/orch/mcp-dispatch.ts` — **NÃO desfazer** autopilot 0.19.26  
17. `src/main/orch/gate.ts` — skill-gate  

### Bloco D — testes a estender (abra junto do código)

18. testes ao lado de `task-router` (`**/*task-router*.test.ts`)  
19. `src/main/orch/mcp-dispatch-security.test.ts` — regressão autopilot  
20. `src/main/orch/tools-domain-mission-authority.test.ts`  
21. `src/renderer/orch/mission-launcher-intent.test.ts`  
22. `src/main/orch/squad-architect-reuse.test.ts`

### Bloco E — referência (só se precisar de padrão)

23. `third_party/provenance/orca-143c36e.json` — o que já veio do Orca  
24. Opcional no Mac: `~/.overclock-app/soft-status.mjs` (padrão idle; **não copiar** binário Overclock)  
25. Opcional: clone Orca `src/main/runtime/orchestration/coordinator.ts` + `preamble.ts` + `lifecycle-reconciliation.ts` (MIT)

**Não leia agora:** mobile Orca RN, redesign UI, voz/Jarvis profundo, media studio.

---

## Mandato (resumo)

1. Bug #1: orquestração não completa missão de ponta a ponta.  
2. Causa: LLM no TUI + prompt-hope; motor não **impõe** rota no spawn.  
3. 0.19.26 (Kimi) já removeu modal por ação + PREVC aditivo + wizard simples — **não desfaça**.  
4. Você implementa **só Onda 0** (abaixo).  
5. Frase de aceite: *O Nexus só avança de versão quando uma missão real completa. Testes verdes sem done/blocked honesto não contam.*

### Definition of Done

```
approve → orch sobe + kickoff com prova idle→busy
       → spawn worker com RouteReservation / roster correto
       → handoff entregue com prova
       → status=done real OU blocked com 1 CTA PT-BR
```

Nota ≥40 chars **sem** worker/handoff **não** conta como done de orquestração (atalho 0.19.26).

---

## O que codar (Onda 0 — nesta sessão)

**Título do PR/commit:**  
`fix(orch): golden-path — RouteReservation + diversity + kickoff acceptance`

### 1) Router (RC1–RC5) — `task-router.ts` + catálogo

- Quality de **fixture** não pre-empta diversidade  
- `matchSignals` com word-boundary (anti `cript` ⊂ `typescript`)  
- Diversidade no tier critical  
- Path agêntico **honra squad salvo** (`squad-architect.ts` / reuse)  
- Não regredir resolve de modelo real da família CLI  

### 2) RouteReservation enforced

- `nexus_route_task` persiste `RouteDecision` na missão (store durável)  
- `nexus_pane_spawn` em missão `running` **exige** reservation válida **ou** `agentName` do roster sticky  
- Violação = erro MCP claro (não sobe codex “qualquer”)  

Arquivos: `tools-panes.ts` (+ dispatch se necessário).

### 3) Kickoff acceptance — `mission-launcher.ts`

- Após paste: edge **idle→busy** em janela finita  
- Falha → `status=blocked` + CTA na UI (nunca silêncio)  

### 4) Idle-delivery — `idle-delivery.ts`

- Falha de aceite do handoff → requeue limitado + sinal UI “handoff não entregue”  

### 5) Testes primeiro

1. Escreva testes **vermelhos** (diversity + spawn sem reservation + kickoff)  
2. Implemente o mínimo  
3. Regressão 0.19.26: missão aprovada **não** chama confirm em `ssh`/`npm test`; `rm -rf` **ainda** confirma (`mcp-dispatch-security.test.ts`)  
4. `npx tsc --noEmit` + vitest focado  

### Fora de escopo

UI redesign · voz · mobile · Tauri · novos adapters · desfazer PREVC aditivo · copiar Overclock.app · importar Orca mobile · release/notarize · “melhorar só o texto do kickoff” sem enforcement.

---

## Arquitetura a impor

> **LLM propõe. Motor Nexus (main) reserva rota, spawna, observa, entrega handoff, avança estado.**

Espelho de mecanismo (não copiar proprietário):

| Fonte | Padrão |
|---|---|
| Overclock local | handoff-driven wait; soft-status multi-CLI; piloto delegateOnly |
| Orca MIT | coordinator tick; worker_done + heartbeat; authority por pane |

---

## 12 regras (não quebrar) + regressão 0.19.26

Ver lista completa em `docs/analysis/PROMPT-GPT-SOL-NEXUS-ORQUESTRACAO.md` seção 5.  
Obrigatório manter: `reserveClaude`, skill-gate dual, login-needed fora do route, fixture quality sem mandar no rank, autopilot sem modal, destrutivo com modal.

---

## Comandos

```bash
cd /Users/cleofaspereirarocha/nexus-ide
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npx tsc --noEmit
node node_modules/vitest/vitest.mjs run src/main/orch/task-router
node node_modules/vitest/vitest.mjs run src/main/orch/mcp-dispatch-security.test.ts
node node_modules/vitest/vitest.mjs run src/renderer/orch/mission-launcher
```

---

## Como trabalhar

1. Ler Bloco A→C (e D ao testar)  
2. Teste vermelho  
3. Fix mínimo  
4. Regressão 0.19.26  
5. CHANGELOG honesto (sem “piloto de verdade” se DoD E2E não rodou)  
6. Doc curta em `docs/analysis/YYYY-MM-DD-golden-path-orch.md`  
7. Relatório final em PT-BR com `arquivo:linha`  

Comece **agora** pela leitura do Bloco A e pelos testes vermelhos de RC1 + RC3.

> O Nexus só avança de versão quando uma missão real completa. Testes verdes sem done/blocked honesto não contam. Não desfaça 0.19.26. Feche RouteReservation + diversity + kickoff proof.

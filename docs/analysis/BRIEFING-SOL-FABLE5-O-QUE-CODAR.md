# Briefing founder → Sol / Fable-5

**Repo:** `cleofasvolarehost/nexus-ide` · `main` @ `0e2396b` · **0.19.26**  
**Docs irmãos:** `PROMPT-GPT-SOL-NEXUS-ORQUESTRACAO.md` (colar inteiro) · `DIAGNOSTICO-SENIOR-NEXUS-2026-07-22.md`

---

## Script curto (cole no chat do Sol)

```
Repo: /Users/cleofaspereirarocha/nexus-ide · main · 0.19.26 (0e2396b).

Kimi já shipou 0.19.26: autopilot sem modal, PREVC aditivo, wizard único.
NÃO desfaça isso.

Bug #1 ainda aberto: motor não DISPACHA com autoridade (LLM no TUI + prompt-hope).
Nenhuma missão real completa com orch de verdade.

VOCÊ CODA SÓ A ONDA 0 — leia e siga PROMPT-GPT-SOL-NEXUS-ORQUESTRACAO.md
(ou o texto completo que eu colei).

Primeira tarefa:
  fix(orch): golden-path — RouteReservation + diversity + kickoff acceptance

DoD: approve → orch + prova kickoff idle→busy → worker rota correta →
handoff com prova → done OU blocked com 1 CTA.
Nota ≥40 sem worker NÃO conta como done de orquestração.

Sem UI redesign, voz, mobile, Tauri, copiar Overclock binário.
Orca MIT ok com attribution. Pare sessões paralelas em orch.

Frase: "O Nexus só avança de versão quando uma missão real completa."
```

---

## O que codar vs o que não mexer

| CODAR (Onda 0) | NÃO MEXER |
|---|---|
| `task-router.ts` RC1–RC5 | Autopilot skip-confirm 0.19.26 |
| RouteReservation em `tools-panes` / spawn | Freeze obrigatório de volta |
| Kickoff idle→busy + blocked+CTA | Redesign wizard |
| Idle-delivery fail visível | Mobile Orca RN |
| Testes vermelhos → verdes | Copiar bytenode Overclock |

---

## Evidência já estudada (pode confiar)

- Overclock local: `~/.overclock-app/soft-status.mjs`, system prompt piloto delegateOnly/chefes, tools do jsc  
- Orca: https://github.com/stablyai/orca · orchestration coordinator/preamble/lifecycle · pin Nexus `143c36e` (102 files)  

---

## Sol vs Fable-5

- **Sol:** implementação Onda 0  
- **Fable-5:** backup, mesmo prompt, nunca paralelo no mesmo código orch  
- **Kimi:** só ops/release se necessário; **fora** de `src/main/orch` até Onda 0 fechar  

---

## Release 0.19.26 (ops, não é Sol)

- Código no GitHub `main`  
- Tag/DMG/notarize pode estar pendente — founder/Kimi; Sol não precisa  

---

> O Nexus só avança de versão quando uma missão real completa. Testes verdes sem done/blocked honesto não contam.

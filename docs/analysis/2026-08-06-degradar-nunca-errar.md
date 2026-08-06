# Princípio de produto: DEGRADAR POR TIER, NUNCA ERRAR

**Origem:** doutrina do Overclock, lida em disco (`system-prompt-pane-105.txt`):
> *"DEGRADE BY TIER, never error… always ship the tier the current keys allow…
> never emit a 'configure img primeiro' error"*

**Tese:** quase toda morte que ele sofreu foi **falta de capacidade respondida
com parede**, quando havia um resultado menor porém FUNCIONANDO disponível.

---

## O princípio, em três regras

1. **Falta de capacidade ⇒ entregar o tier possível**, nunca recusar a missão.
2. **A redução é SEMPRE visível** — mesma superfície do veredito de teto
   ("N de M elegíveis"). Degradar em silêncio seria trocar uma doença por outra.
3. **Bloquear só quando NÃO existe resultado menor funcionando** — e aí a
   mensagem tem de ser acionável (o que fazer, não o que faltou).

---

## Inventário dos blocos duros no caminho da missão

19 códigos nomeados encontrados em `guided-mission-planner.ts`,
`mission-kickoff.ts`, `mission-orchestrator-bootstrap.ts`,
`guided-mission-prevc.ts`, `mission-scheduler-production.ts`.

Ranqueado por **quantas vezes ELE encostaria**:

| # | Bloco | Hoje | Tier degradado | Freq. |
|---|---|---|---|---|
| 1 | `guided_plan_ownership_missing` / `wave_pack_ownership_missing` | recusa: *"o inventário seguro do projeto está vazio"* | rodar em `same_checkout` com **1 escritor** e ownership = alvos do goal (ou raiz do repo). Aviso: *"não consegui mapear áreas do projeto; rodando como escritor único"* | **Alta** — qualquer repo com layout incomum |
| 2 | `guided_prevc_*` (7 códigos: freeze_failed, freeze_incomplete, contract_stale, late_freeze_blocked, context_bootstrap_blocked, contract_missing, invalid_route) | recusa a execução | **pular PREVC** e rodar no caminho simples, marcando o receipt como sem-freeze. Aviso: *"contexto não congelado; entrega segue sem selo de PREVC"* | **Alta** — travou missão por dias em 30/07 |
| 3 | `guided_plan_legacy_receipt_blocked` | *"reaprove a missão para selar um plano roster-complete v2"* | **re-selar sozinho**. E note: pedir "reaprove" ficou **incoerente** depois que a aprovação foi removida (2e24cee3) — hoje manda o usuário a uma porta que não existe mais | **Alta** — bateu hoje no ciclo greenfield |
| 4 | `guided_plan_squad_missing` / `_stale` / `_unbound` | recusa por squad ausente/velho | cair no **roster padrão** do autopilot com aviso de qual squad foi usado | Média-alta |
| 5 | leque colapsado por 1 story sem ownership (`every()`) | todas serializam | **leque parcial**: declaradas em paralelo, indeclaradas atrás (já desenhado em F2) | Média-alta |
| 6 | `guided_plan_roster_too_large` | recusa | **truncar ao teto** com aviso de quem ficou de fora | Média |
| 7 | `guided_team_fanout_empty` | recusa | **1 unidade** e veredito de fase sequencial | Média |
| 8 | `recovery_lock_busy` | recusa | **enfileirar e reentrar**, nunca recusar | Média |
| 9 | Provider de voz ausente | Space morto | **cair para texto** com aviso | Média |
| 10 | `guided_plan_mixed_topology_blocked` | recusa receipt que mistura wave-pack e delivery | **legítimo manter** — é corrupção de topologia, não falta de capacidade. (Verificado: NÃO conflita com o plano misto simples/isolado que a 0.27.0 introduziu — aquele é dentro da topologia de delivery) | Baixa |

**Bloqueio que continua legítimo:** #10, e qualquer violação de autoridade
(recibo físico ausente, CAS perdido, cronologia inválida) — ali não existe
"resultado menor", existe resultado FALSO.

---

## Como implementar sem virar silêncio

Reusar exatamente o que já funciona: `diagnoseWaveConcurrency` provou que
**dizer o motivo na tela** transforma "está travado" em "está trabalhando".

Proposta: um `missionDegradation` com o mesmo formato do veredito —
`{ what, reducedTo, why, recoverable }` — emitido no mesmo journal
(`mission_events`) e mostrado no card. Exemplos:

> *"PREVC não congelou; entrega seguiu sem selo de contexto."*
> *"Não mapeei áreas do projeto; rodei como escritor único."*
> *"Roster tinha 14 agentes; usei os 8 que cabem."*

---

## Ordem sugerida
#3 primeiro (é incoerência viva: pede reaprovação que não existe mais),
depois #1 e #2 (as duas de maior frequência), depois #5 (já desenhado no F2).

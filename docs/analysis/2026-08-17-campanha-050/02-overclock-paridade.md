# Campanha 0.50 — Fase B: paridade Overclock/bridge (diff mecânico×nexus)

Data: 2026-08-18. Fontes: `~/.overclock-app/*.mjs` vivos (handoff-deliver,
handoff-stop) + blueprint da memória + `src/main/orch/turn-end-handoff.ts`
(C-194.1 portado em 52c59f08) + `mission-fast-lane.ts`.

## O que o Nexus JÁ tem e é igual ou melhor

| Mecanismo Overclock | Nexus | Veredito |
|---|---|---|
| C-194.1 fechamento mecânico verbatim (≤280 inteiro / >280 verdade+ponteiro) | `buildMechanicalHandoffPayload` idêntico (réguas 280/60k/[auto]) | parity |
| F-339 origem do input (humano vs sistema) | `getLastSessionInputOrigin` — dado nativo, sem arquivo | nexus melhor |
| Dedup de Stop re-disparo | fingerprint turno+texto + dedup por **encarnação** | nexus melhor |
| Corrida de flush do transcript (~83ms) | payload em memória (F-355) + poll transcript com backoff 2s | parity |
| Fail-open do neto (não prender o turno) | fire-and-forget no /hook/status + log nomeado | parity |

## GAPS — o que o Overclock faz e o Nexus NÃO (mapeados na Fase A)

**B1 — session-end é observe-only lá, block falso aqui (mata A3).**
Overclock: `SESSION_END_REASONS = ['channel_closed','shutdown']` — Stop de
fim de SESSÃO não fabrica entrega nem falha. Nexus: quit do operador com
handoff `success`+delivery `accepted` não-ackado → missão acorda `blocked`
"Handoff não entregue" — o trabalho estava pronto (handoff-1c5341ac:
"consolidei os sete code reviews"). **Fix: reconcile no boot** — handoff
success+accepted não-consumido vira consumo/conclusão, nunca block.

**B2 — lifecycle de worker invisível (mata A1/A7).**
Overclock: cada pane tem arquivos de estado no chão (`input-origin-*`,
`handoff-stopcount-*`, `handoff-pending-*`) — o diagnóstico sobrevive ao
app. Nexus: PTY morre entre spawn e primeiro turno e NADA fica (journal só
tem session_spawned). **Fix: eventos de lifecycle no journal** (boot ok,
primeiro output, primeiro turno, exit com causa/exitCode, respawn #n) +
main.log persistente no app empacotado.

**B3 — teto de respawn com troca de rota (mata A2).**
Overclock: `handoff-stopcount-<pane>` conta e o doctor (`overclock-doctor`)
age. Nexus: mesmo pane respawnado 6× com 0-1 turnos, sem aprendizado.
**Fix: após N mortes sem turno → trocar adapter/rota ou dispensar a task
com motivo** (a diretiva de reroute do roster já existe — 0.19.42 — só
não é acionada por mortalidade de boot).

**B4 — handoff stalled com TTL (mata A4).**
16h de handoff `stalled` sem dono. Overclock: pending-markers têm dono e o
stop-count limita. **Fix: TTL de stall + descarte escalonado com evento.**

**B5 — anti-eco de entrada (WAKE_RE `<channel via=…>`).**
Overclock marca a entrega no canal e o receptor reconhece a própria
entrega como não-trabalho. Nexus decidiu por guarda de papel (só
orquestrador recebe; orquestrador é skip) — CORRETO hoje, mas quando
derivermos entrega entre workers (fan-out), voltar a este mecanismo.

## Não-portar (deliberado)

- **C-194 auto-condense** (pergunta natural + íntegra guardada): nossa
  regra 1.2.3 entrega verdade+ponteiro sem queimar um turno extra. Mantém.
- **Arquivos no chão como fonte de verdade**: o Main é dono do PTY/store;
  arquivo seria retrocesso.

## Ordem de ataque sugerida (0.50)

1. B1 (reconcile de shutdown) — menor esforço, maior dor do usuário.
2. B2 (lifecycle journal + main.log) — pré-requisito de B3 e do harness D.
3. B3 (teto de respawn + reroute por mortalidade).
4. B4 (TTL de stall).

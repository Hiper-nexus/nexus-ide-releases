# 2026-08-21 — Cruzamento Overclock × Nexus: por que lá termina e aqui não

Varredura feita em 21/08/2026 sobre: app instalado `/Applications/Overclock.app`
(v1.3.5, Tauri+bytenode), dump legível `~/go/overclock-app-dump.md` (estado de
`~/.overclock-app` de 11/08), extração `overclock-extracted/` (skills 1.2.4),
estado vivo `~/.overclock-app/` (missions.json, handoffs.db, marcadores) e as
análises anteriores de paridade em `docs/analysis/`.

## 1. A filosofia que faz o Overclock terminar missões

Término é **mecânico por padrão** e **fail-open**:

| Mecanismo | Como funciona |
|---|---|
| Auto-submit no Stop hook | Worker que para sem `handoff_submit` tem a ficha fechada pelo hook (`[auto]` + transcript). O modelo não cooperar é irrelevante |
| Gate de evidência | `done` sem prova vira `blocked` no próprio submit — impossível terminar sem rastro |
| Hook desacoplado | Grava payload em disco, relança detached, sai exit 0 em ms — CLI nunca fica preso em retry |
| Fail-open | Sinal ausente/desconhecido ⇒ entrega assim mesmo ("eco a mais é ruído; resultado perdido é o bug") |
| Disco é a autoridade | 344 fichas nunca entregues fisicamente no `handoffs.db` vivo e nada apodreceu — chefe consome lendo (pull) |
| Estados de morte nomeados | `done 424 · progress 76 · dead 38 · abandoned 27 · blocked 25 · closed_by_caller 13 · stalled 10` |
| Degradação por tier | Sem credencial ⇒ troca de adapter/tier. Nunca error. Nunca espera pane que não nasce |
| Doctor first-party | `overclock-doctor.mjs`: soft-waiting >30min, pane morto >24h, missão running >7d → relata/arquiva |

## 2. Placar de paridade (mecanismo → status no Nexus)

IMPLEMENTADO: worker-handoff-ttl (~30s), fechamento mecânico/Pronto
observacional, input-origin humano×sistema, outbox durável + reconcile 1s,
multi-dialeto payload, zero-delivery watchdog, fan-out declarado,
trace.ndjson, respawn com re-entrega, hang-watchdog.

PARCIAL/AUSENTE na data:
1. Settlement idempotente (success+accepted → conclusão) — **corrigido F-102**
2. Fallback de assento missing-credential — **corrigido F-101**
3. TTL de handoff stalled + descarte escalonado com estados nomeados
4. Mortality régua 10 (docs prometiam ≤3) + boot-reconcile SQL
5. Liveness tri-state (C3) / heartbeat (C5) — adiados
6. Auto-submit fail-open universal (nosso turn-end é enforcement opt-in)
7. Doctor first-party do Nexus (diagnóstico pós-mortem cego — A7)

## 3. Causas raiz de "missão nunca completa" (ranqueado)

1. Transporte = TUI (digitar no PTY), não caixa postal; ack por desenho de tela
2. Desencaixe entrega→ack→conclusão fabrica block falso (F-102)
3. Mortalidade de worker invisível; Maestro ocioso 246 ticks (A1/A2)
4. Spawn falho sem fallback (F-101)
5. Conclusão falsa: Via Rápida contava repo inteiro como prova
6. Topologia colapsa objetivo NL em executor único (mission-topology.ts)
7. Enforcement global vs conclusão observacional (B1) — hoje default-off
8. Handoff stalled sem dono nem TTL (A4/B4)
9. Diagnóstico pós-mortem cego (sem main.log empacotado)
10. Cerimônia pré-worker: 25+ gates antes do primeiro pane

## 4. Onda 1 executada nesta data

- **F-101**: `spawn-seat-fallback.ts` + wiring em `spawnPaneAndMaybePrompt`
  (cadeia primário→escalação→piso sondada; falha não-credencial segue
  fail-closed).
- **F-102**: settlement idempotente via `hasUnsettledQueuedHandoffs`
  (civilian-delivery-completion + civilian-pronto); veredito terminal settle,
  ack físico best-effort.
- **E2E REAL EM DEV ABERTO (21/08 ~17:50)**: missão
  `mission-9c9a44a7-9917-4640-b217-062f0f8ad2d6` ("pergunte a cada pane quanto
  é 1+1 e consolide") criada via bridge do renderer em `npm run start` com
  roster real (Maestro codex, Pane A codex, Pane B deepseek, QA codex).
  Deepseek falhou boot uma vez e foi re-spawnado (resiliência ok); resposta do
  Pane B capturada por FECHAMENTO MECÂNICO `[auto]` (turn-end-handoff);
  list-ack por leitura funcionou; missão convergiu para `completed` com
  summary = consolidado citando as DUAS respostas ("2"). Marco 7.3 do
  HANDOFF-MANAGER batido pela primeira vez sem intervenção humana pós-start.
  Dívida cosmética observada: artifactRefs lista walk inteiro do workspace
  (causa raiz #5 — gate de artefato ainda não filtra lixo tipo .DS_Store).
- Próximos (Onda 2): auto-submit fail-open universal, estados de morte
  nomeados + TTL stalled, mortalidade ≤3, nexus-doctor.mjs.

## 5. Achados de segurança

`~/.overclock-app/providers.json` e `audio-config.json` têm chaves de API em
texto plano (criptografia `OCK1` quebrada desde 01/07, marcador
`.providers-encryption-broken`). Recomendação: rotação imediata das credenciais.

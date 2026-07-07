# Varredura Sênior NexusIDE — Bugs, Visual Pixel Art e Jarvis Operacional

Data: 2026-07-07
Escopo: leitura + diagnósticos read-only + 2 auditorias paralelas (visual e bugs), seguidas de execução das correções na branch `senior-sweep-2026-07-07`. Recriado neste worktree após o original (untracked no worktree principal) ser removido por limpeza paralela.

Documentos irmãos:

- `docs/analysis/nexus-vs-overclock-bridge.md` — análise profunda Jarvis vs Overclock/Bridge (P0→P4). Este documento complementa com bugs, visual e o delta do dia.
- `docs/audit/2026-07-05-*.md` — auditoria de 05/07; vários itens já corrigidos (seção 6).

---

## 1. Sumário executivo

O Nexus não está estruturalmente podre — typecheck verde, 711 testes passando, PTY isolado em `utilityProcess`, sandbox de arquivos fail-closed, MCP local com autorização por pane. O problema real combina quatro frentes:

1. **Confiabilidade empacotada**: 3 crashes SIGTRAP (0.1.0, 0.7.0, 0.10.1) com a MESMA stack em runtime nativo. Suspeitos: `onnxruntime-node` fora do rebuild Electron e/ou crash interno do Electron (rede/c-ares). Somam-se: remote bridge auto-start em `0.0.0.0`, handlers CSP duplicados, retry infinito de load.
2. **Jarvis com o "último quilômetro" desligado**: causa raiz do "não acorda" identificada e corrigida HOJE (APM/autoGainControl do Chromium achatando o fifine — commit `897ce56`/v0.10.6 + makeup gain 3x validado ao vivo). Gaps restantes: `REALTIME_ACTION_BRIDGE_ENABLED = false`, catálogo de 9 ações em switch no renderer, sem leitura de tela — todos em execução ativa nas branches fase3/4/5.
3. **Visual com duas identidades competindo**: ilhas pixel art de qualidade (PixelIcon, NexusMark, OperatorSprite, Ops Board) afogadas num shell "IDE dark SaaS" (sans antialiased, glassmorphism, radius 8–18px). Fundação pixel aplicada no sweep.
4. **Higiene**: 86 hex hardcoded, paleta de status fragmentada, scrollbars default, emojis misturados com PixelIcon — tratados no sweep.

## 2. Metodologia

| Fonte | Como | Confiança |
|---|---|---|
| Diagnósticos locais | typecheck, testes, PlistBuddy, crash reports `.ips`, `~/.nexus/logs/voice.log`, system_profiler | Alta |
| Auditoria visual | subagente — 105 arquivos do renderer + global.css (6414 linhas) | Alta |
| Auditoria de bugs | subagente — src/main, src/renderer, server/, src/preload, forge | Alta |
| Validação hands-on | dev run 13:15-13:46 com wake/STT ao vivo | Alta |

## 3. Estado de saúde verificado

### 3.1 Verde
- typecheck e 711/711 testes (repo e worktree sweep pós-correções).
- App instalado 0.10.5 = repo (alinhado de manhã); v0.10.6 commitada à tarde com o fix APM.

### 3.2 Crashes SIGTRAP
Os 3 reports compartilham: `EXC_BREAKPOINT`, thread `ThreadPoolForegroundWorker`, frames 100% no Electron Framework (símbolos aproximados de c-ares/http2/V8), nenhum frame de `.node` do app. Hipóteses em ordem de custo: (1) `onnxruntime-node` fora do `rebuild:electron` — **corrigido no sweep**; (2) crash interno do Electron — se persistir, upgrade + simbolização com dSYM.

### 3.3 Jarvis surda — causa raiz CONFIRMADA ao vivo
- Sintoma: `mic.health: silent` com permissão granted; zero `wake.detected`; macOS ouvindo o fifine normalmente.
- Causa: APM do WebRTC (echoCancellation/noiseSuppression/autoGainControl default) achatando o sinal do mic USB para RMS ~0 e corrompendo as features do openWakeWord.
- Fix: APM off no stream do wake (`897ce56`, v0.10.6) + diagnóstico `mic.device`/`mic.firstFrame`.
- Validação hands-on (13:16): `wake.detected` score 0.60→pico 0.922 na primeira tentativa em dev.
- Descoberta pós-fix: sem AGC o sinal fica fraco (usuário quase gritando; scores 0.39-0.47) → **makeup gain 3x** (+9.5dB, clamp ±1) aplicado em `wake-mic.ts` e validado (scores 0.77-0.99 com voz normal). PENDENTE DE COMMIT no worktree principal.

## 4. Varredura de bugs — status pós-sweep

Todas as correções abaixo estão commitadas em `senior-sweep-2026-07-07` (commit `e52060d`), validadas com typecheck + 711 testes:

| Sev. | Onde | Problema | Status |
|---|---|---|---|
| Crítico | `package.json` | rebuild sem `onnxruntime-node` → SIGTRAP | ✅ corrigido |
| Crítico | `orch-ipc.ts`/`remote-bridge.ts` | bridge auto-start em `0.0.0.0` | ✅ sem auto-start; default 127.0.0.1; `boundHost` rastreado |
| Crítico | `wake-engine.ts` | custom.onnx sem validação | ✅ validação + fallback pro embutido |
| Alto | `voice-ipc.ts`+`wake-engine.ts` | race na init (frames descartados) | ✅ fila durante init (fechou race do seedBuffers também) |
| Alto | `window.ts` | CSP duplicado no activate | ✅ guard module-level |
| Alto | `billing-ipc.ts` | licença sem reverificação JWT | ✅ verified:true/false; token persistido |
| Alto | `db.ts` | SQLite degradado silencioso | ✅ error explícito + isDbDegraded() |
| Alto | `window.ts` | retry infinito de load | ✅ teto 20 + backoff |
| Médio | `voice-ipc.ts` | sem dispose do WakeEngine | ✅ dispose() com release das sessões ONNX |
| Médio | `wake-engine.ts` | pcmQueue sem cap | ✅ cap ~4s, drop dos antigos |
| Médio | `layout-store.ts` | write não-atômico | ✅ writeJsonAtomic |
| Médio | `deep-link.ts`/`onboarding-store.ts`/`hooks-gen.ts` | rejeições/parses engolidos | ✅ catch com log |
| Médio | `CanvasPaneNode.tsx` | terminal órfão no snapshot | ✅ detach no cleanup do effect |
| Médio | `claude-transcript-watcher.ts` | readdirSync em hot path | ✅ async |
| Médio | `webhook-routes.ts` (server) | processedAt inconsistente | ✅ transação Drizzle + re-throw |
| Médio | `index.ts` (server) | sem rate-limit global | ✅ 300 req/min, webhook excluído |
| Baixo | `preload.ts` pathForFile, `tts as any`, `.catch(() => {})` | erros silenciosos | ✅ logs/tipagem |

Follow-ups em aberto: botão "Iniciar" da bridge na UI precisa de toggle explícito p/ LAN (`{host:'0.0.0.0'}`) quando o fluxo mobile voltar; `uiohook-napi` como optionalDependency (exige decisão de install).

Achados NOVOS do teste dev (para triagem): `[window] root vazio após 20s — reload 1` no boot dev (watchdog recuperou, causa a investigar); `usage:snapshot` sem handler registrado (preload expõe, main não registra — provável regressão das fases); better-sqlite3 com ABI errado no dev (rodar `npm run rebuild`).

## 5. Auditoria visual — aplicada no sweep

Diagnóstico: duas estéticas competindo (ilhas pixel vs shell SaaS). Fundação aplicada no commit `e52060d`:

- `global.css` (6414 linhas) fatiado em 11 módulos via `@import` (cascata preservada) — forçado pela regra de 800 linhas do projeto, resolveu o monólito de brinde.
- VT323 local (OFL) + `--font-pixel`; aplicada em settings-nav/ops-board/workspace-bar (≥12px).
- `--ease-out-expo` corrigido (era auto-referência que anulava animações).
- Modo pixel opt-in: `applyPixelMode()` seta `data-theme-pixel` (radius 0 global, font pixel, smoothing off). Falta ligar na UI de Settings.
- Status unificados em `--ok/--live/--warn/--danger` (Mission Rail, orch tags, CostBadge, toasts...).
- `--accent-hover`; scrollbar pixel global; glassmorphism removido (Home deck, Voice HUD via CSS); radius 0 nos overlays hero; `:focus-visible` estendido; ErrorBoundary tokenizado; duplicações CSS mescladas.
- PixelIcon: +7 ícones (chevron-down, bolt, key, id-badge, warn, user, users); emojis eliminados de MissionWizard/Launch/Files/Catalog/Account; settings-nav com campo `pixelIcon`.

Pendências visuais (fases seguintes): redesign do Voice HUD (orb → OperatorSprite + waveform pixel), sticky notes, tema xyflow, preset "Pixel Terminal", blur do onboarding, badges mono restantes da nav.

## 6. Evolução 05/07 → 07/07

| Item | Status |
|---|---|
| PTY no main (crash derruba app) | ✅ utilityProcess |
| Sandbox caindo pro home | ✅ fail-closed + realpath |
| Janela preta sem recovery | ✅ watchdog 2 fases |
| Estado exited invisível | ✅ toolbar com CTA |
| onMouseDown sem teclado | ✅ onClick + aria-label |
| run_command sem confirmação | ✅ dialog nativo |
| App ≠ repo | ✅ alinhado |
| Jarvis surda | ✅ causa raiz + fix validado ao vivo |
| Bugs críticos de build/segurança | ✅ sweep e52060d |
| Fundação pixel | ✅ sweep e52060d |

## 9. Mapa de trabalho paralelo e fronteiras

Baseline comum: todas as branches partem de `7927f10` (0.10.5).

### 9.1 Frentes

| Frente | Branch/worktree | Entrega | Status |
|---|---|---|---|
| Jarvis P1 realtime | `nexus-jarvis-fase3-realtime` | providers OpenAI Realtime + Gemini Live, factory, métricas, transcript store | commits feitos |
| Jarvis P2 MCP | `nexus-jarvis-fase4-agent` | tool bridge MCP, guardrails, permissions, audit-log, tools editor/files/git/terminal | commits feitos |
| Jarvis P3 vision | `nexus-jarvis-fase5-vision` | screen capture + OCR tesseract + AX tree + VisionIndicator + privacy guard | commits feitos |
| Fix APM + release | main | APM off no wake (897ce56, v0.10.6) | ✅ commitado |
| Makeup gain 3x | working tree do main | `WAKE_MAKEUP_GAIN = 3` em wake-mic.ts, validado ao vivo | ⚠️ PENDENTE DE COMMIT |
| Sweep sênior | `senior-sweep-2026-07-07` | bugs/segurança + fundação pixel (e52060d) | ✅ commitado e validado |

Stashes `recover ... from mixed workspace` (0-3): NÃO dropar até confirmar absorção pelas branches.

### 9.2 Colisões conhecidas (arquivo, não função)

| Arquivo | Quem toca | Risco |
|---|---|---|
| `voice-ipc.ts` | fase3 + sweep (dispose/fila) | conflito pequeno |
| `global.css` | fase3/fase5 (+`.vision-indicator`) + sweep (AGORA É MANIFESTO de @import — os blocos das fases precisam migrar pro módulo certo) | atenção no merge |
| `PixelIcon.tsx` | fase5 (`vision`) + sweep (7 ícones) | ambos adicionam; manter os dois |
| `package.json` | fase5 (deps) + sweep (rebuild) + release (versão) | auto-merge |
| `preload.ts` | fase4/5 + sweep (1 warn) | trivial |

### 9.2.1 Recomendações para a fase3 (achados do hands-on 13:15-13:46)

1. **Makeup gain é obrigatório com APM off**: sem AGC o fifine fica fiel porém fraco (wake 0.39-0.47, usuário gritando). `WAKE_MAKEUP_GAIN = 3` validado ao vivo (0.77-0.99 voz normal). Commitar; futuro: ganho adaptativo por RMS médio.
2. **Captura deve começar NO wake, não após o ack**: hoje toca "Pois não?" e SÓ DEPOIS abre a escuta — comando emendado ("Hey Jarvis abre um terminal") cai fora da gravação; captura fecha em quase-silêncio e o Whisper alucina "E aí" (observado 3× no teste). Fix: pre-roll buffer desde `wake.detected` + captura durante o ack (padrão Siri/Alexa/Overclock).
3. **STT primário do usuário trocado para Groq whisper-large-v3-turbo** (backup `nexus-voice.json.bak-pre-groq`) — corta 1-3s/turno na rota Classic até o realtime chegar. Medido ao vivo: transcrição caiu para 466-766ms.
4. **CRÍTICO — eco/self-talk agora é responsabilidade do app**: com o APM off, o `echoCancellation` que filtrava a voz da própria Jarvis do mic SUMIU (o comentário em `voice-controller.ts:614` "echoCancellation filtra do próximo turno" ficou obsoleto). Observado ao vivo (13:54): loop completo de self-talk — a Jarvis capturou o próprio TTS como fala do usuário e conversou consigo mesma por vários turnos (agravado por `expectReply` reabrindo a escuta + makeup gain + fifine ser input E output default). Mitigação imediata aplicada: saída de áudio movida para os alto-falantes do MacBook (separação física). Fix de código necessário: suprimir captura/wake durante TODO o playback de TTS (hoje só o ack tem 1.5s de supressão), janela anti-eco cobrindo a duração real do áudio + margem, e/ou AEC por software. Sem isso, o realtime full-duplex da fase3 vai sofrer o mesmo loop.

### 9.3 Ordem de integração (nada é jogado fora)

```text
1. commitar o makeup gain (wake-mic.ts, working tree do main)
2. main ← senior-sweep (estabilidade + pixel; atenção: global.css virou manifesto)
3. main ← fase3 → fase4 → fase5 (ordem de dependência)
   conflitos esperados: voice-ipc, global.css (migrar blocos pros módulos), PixelIcon
4. validar: typecheck + testes + smoke empacotado com wake ativo
5. empacotar 0.10.7+ e reinstalar — só aí o app instalado acorda de vez
```

### Critério de "produto melhor" (2 semanas)
- zero SIGTRAP com wake ativo; Jarvis acorda com voz normal <1s; porta da bridge fechada por default; toggle pixel funcional; paleta de status única; realtime da fase3 ligado com ack <500ms.

# Jarvis Deep Audit — 2026-07-11

Auditoria honesta: logs de produção, código de ponta a ponta, docs internas e
referências externas (Gemini Live + OpenAI Realtime + openWakeWord).

## Resposta direta

**Na primeira rodada de UI/voz: NÃO.** Foi recorte (barra, seletor, defaults
masculinos) + amostra dos logs. Não foi estudo completo nem pesquisa web.

**Nesta rodada: SIM.** Forense em `~/.nexus/logs/voice.log`, leitura de
`docs/JARVIS-PORTING.md`, `docs/analysis/2026-07-07-jarvis-operational-gap.md`,
pipeline main+renderer, e best practices Gemini Live / OpenAI Realtime / OWW.

---

## Como a Jarvis DEVERIA operar (alvo “nível máximo”)

Modelo mental de um voice agent realtime de produto (Gemini Live / OpenAI Realtime):

| Princípio | Expectativa do usuário | Fonte |
|---|---|---|
| Sessão contínua | Depois do wake, NÃO precisa repetir “Hey Jarvis” a cada frase | Gemini Live: barge-in + session; OpenAI: `interrupt_response` + VAD |
| Wake confiável | ≤2s do “Hey Jarvis” → ack ou escuta aberta | openWakeWord + fallback STT; HA: “sem pausa entre Hey e Jarvis” |
| Prefill de comando | “Hey Jarvis, abre o terminal” numa fala | pre-roll + pending mic buffer |
| Full-duplex real | Interromper a fala dela; eco filtrado sem matar o engajamento | AEC off no wake; echo text window no live |
| Tools no modelo | Ações IDE via function calling na sessão live | Gemini Live tools; bridge Classic/MCP |
| Degradação limpa | Sem key/rede → Classic STT→brain→TTS, sem “surda para sempre” | cadeia error-driven Nexus |
| VAD calibrado | Não cortar no meio; não esperar 6s em silêncio | OpenAI server_vad / semantic_vad; Gemini VAD docs |

Arquitetura alvo Nexus (já desenhada, parcialmente entregue):

```
Mic always-on 16kHz APM-off
  ├─ openWakeWord (local) ──score≥0.42──► engage Live
  └─ VAD short clip → STT passivo (Groq) ──match nome──► engage Live
         │
         ▼  Gemini Live (prioridade) ──fallback──► OpenAI Realtime ──► Classic
         │  tools: navegar/delegar/ler/comandar/…
         │  session warm (grace 90s) → dormant (5min) → reuse
         ▼
      actions auditáveis (MCP + guardrails nativos)
```

---

## Como opera HOJE (código real)

Dois executores (`docs/JARVIS-PORTING.md`):

1. **Classic** — batch: captura → STT → brain → action → TTS → talvez reabre.
2. **Gemini Live / OpenAI Realtime** — full-duplex; tools no provider; brain/actions
   compartilhados. Config do usuário: `transport=gemini-live`, Live enabled.

Pontos fortes já no código:

- Pre-roll de wake, strip de ack/eco, wake-lock multi-instância
- AGC/APM desligados no stream de wake (fix “Jarvis surda” por AGC)
- Fallback STT/TTS/brain error-driven
- Engage decision Gemini→OpenAI, mute-degrade → Classic
- Tool catalog + guardrails + memory

---

## Forense dos logs (voz.log, ~799KB, 11/jul)

| Evento | Contagem | Leitura |
|---|---:|---|
| `wake.score` | **3698** | Detector rodando sem parar |
| `wake.passiveSample` / `Checking` | 421 | Fallback STT tentando |
| `wake.passiveMiss` | **420** | STT NÃO confirma o nome (**99.8% miss**) |
| `wake.passiveDetected` | **1** | Quase nunca acorda por STT |
| `peakScore` max | **0.109** (p95 **0.017**) | Threshold **0.42** — **nunca cruza** |
| `mic.health: silent` | 115 | Intermitente (TCC/device); não é o único problema |
| `live.noiseDiscarded` | 2 | **`"Hey, Javes."` / `"Ei, Jarvis."`** |
| `jarvis.realtimeMuteDegraded` | 2 | Live “mudo” 6.5s → fallback Classic |
| `jarvis.engageDecision` gemini | ok | Key Gemini OK, transport gemini-live OK |

### Smoking guns

1. **Wake acústico morto em PT-BR**  
   openWakeWord (modelo EN “hey jarvis”) max score 0.11 vs 0.42. Mic tem RMS alto
   (0.3–0.6). Não é volume; é modelo/acento.

2. **Wake STT passivo quase morto**  
   420 miss / 1 hit. Sem fingerprint antigo (agora loga). Groq ~400–1900ms.

3. **Live descarta o próprio engajamento**  
   ```
   live.noiseDiscarded … "Hey, Javes."
   live.noiseDiscarded … "Ei, Jarvis."
   jarvis.realtimeMuteDegraded … waitedMs:6500
   ```
   `isLikelyNoiseTranscript` tratava cumprimento+nome como ruído (`ei`+`jarvis`
   ambos “noise tokens”). **Isso explica “não dá sequência” no Gemini Live.**

4. **Click-wake chega no Gemini**  
   `live.micFramesSent`, `live.serverAudioChunk`, `live.audioPlayed` — o socket
   funciona. O pipeline morre no filtro de transcript, não na rede.

---

## Fix aplicado nesta auditoria

`src/shared/voice-noise.ts`:

- `isWakeAddressTranscript("Ei Jarvis" | "Hey Javes" | "e aí jarvis")` → **NÃO** é ruído
- Nome sozinho garbled (`javis`) continua ruído (eco de TTS)
- Testes atualizados com evidência de produção

Reiniciar o app para carregar o fix.

---

## Gap list priorizada (P0→P2) para “nível máximo”

### P0 — acorda e conversa (bloqueadores)

| # | Problema | Ação |
|---|---|---|
| P0.1 | ~~Live descarta “Ei Jarvis”~~ | **FEITO** (voice-noise) |
| P0.2 | openWakeWord score ~0 | Treinar/baixar head PT-BR; ou baixar threshold **só** com ROC local; dual-path STT-first em PT |
| P0.3 | passiveMiss 99.8% | Log fingerprint (feito); alinhar matcher aos fingerprints reais; aumentar janela speechMs mínima se clip truncado |
| P0.4 | realtimeMuteDegraded 6.5s | Após fix P0.1, revalidar; se persistir, alongar waiter e/ou forçar `create_response` no engage |

### P1 — sensação “Jarvis de filme”

| # | Problema | Ação |
|---|---|---|
| P1.1 | Continuity pós-dormant | Garantir que follow-up sem wake reusa session (grace 90s) e UI mostre “pronta” não “morta” |
| P1.2 | Barge-in | Gemini barge-in + interrupt path já existe; validar com fala sobre a resposta |
| P1.3 | Tools no Live | Coarse tools + nexus_action; auditar se Gemini está chamando tools ou só falando |
| P1.4 | Voz masculina Charon | Config migrada; seletor Gemini first na UI |
| P1.5 | language_code PT | Gemini best practices: setar audio/transcription language `pt-BR` se ainda não |

### P2 — excelência

| # | Ação |
|---|---|
| P2.1 | semantic VAD (OpenAI fallback) / tuning silence_ms |
| P2.2 | Context compression Gemini em sessões longas |
| P2.3 | Proactive audio control (quando falar vs silêncio) |
| P2.4 | Modelo wake custom PT-BR (openwakeword.com / training colab `training/ei-jarvis`) |
| P2.5 | HUD de saúde: score wake, last STT fingerprint, live ready, mute degrade |

---

## Referências externas consultadas

- [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api) — full-duplex, barge-in, tools, PCM 16k in / 24k out
- [Gemini Live best practices (Cloud)](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/best-practices) — system instructions, VAD, language codes, session resumption, client buffering
- [OpenAI Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad) — server_vad / semantic_vad, create_response, interrupt_response
- [openWakeWord](https://github.com/dscripka/openWakeWord) — custom heads; EN models falham em sotaque sem treino
- Community HA: “Hey Jarvis” precisa ser dito **sem pausa** entre Hey e Jarvis

---

## Critérios de aceite mensuráveis

1. Dizer “Hey Jarvis” → engajamento ≤2s em ≥4/5 tentativas (log: `wake.passiveDetected` ou `wake.detected` + `engageDecision`)
2. Click no orb → áudio Gemini em ≤3s, **sem** `noiseDiscarded` de “Ei Jarvis”
3. Comando colado: “Hey Jarvis abre o terminal” → tool/navegar sem repetir wake
4. 5 turnos seguidos no Live sem `realtimeMuteDegraded`
5. `peakScore` logado + fingerprint em todo miss (diagnóstico contínuo)

---

## O que falta fazer na próxima sessão de código (recomendado)

1. Validar P0.1 com app reiniciado + logs
2. Instrumentar passive STT: se fingerprint mostrar “hey javes”, matcher já cobre; se vazio, VAD truncando
3. Caminho **STT-first wake** em PT (skip openWakeWord quando score p95 < 0.1 por sessão)
4. Confirmar `language` PT no Gemini Live session setup
5. Smoke: 5 turnos hands-free com tools

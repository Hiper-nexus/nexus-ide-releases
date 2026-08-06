# Paridade ClockVoice (Overclock) × NexusVoice — mineração e delta por salto

**Data:** 2026-08-06 · **Diretiva do usuário:** "copiar TUDO do Overclock" · **Método:** leitura de `~/.overclock-app/audio-config.json` (texto plano — OBSERVED), atestado de dentro do Overclock (o coordenador RODA nele — ATTESTED), bundle bytenode (ilegível — INFERRED/UNKNOWN marcados).

## Fonte primária (OBSERVED, ~/.overclock-app/audio-config.json)

ASR: **Groq cloud, whisper-large-v3** (endpoint openai-compatível) · `language: pt` · prompt de domínio ("Overclock, Claude, Codex, MCP, pnpm, TypeScript…") · `chunkMs: 4700` · `outputMode: "english"` · `captureMode: "hold"` · `pushToTalkKey: Space` · `interactionMode: "coding"` · `targetWpm: 190` · sem binário/modelo local (`localBinaryPath: ""`). Há uma API key em texto plano no arquivo — **anti-requisito** (Nexus guarda por envVar/vault).

## Delta por salto

| Salto | Overclock (confiança) | Nexus hoje | Ação |
|---|---|---|---|
| **Arm** | Hold de Space com toque digitando espaço; captureMode "hold" (OBSERVED); mecânica exata do listener UNKNOWN (bytenode); funciona com pane de terminal focado (ATTESTED) | `attachWindowPtt` + `HoldToTalkDiscriminator` (954b1ae3), janela-escopo, retém keydown até limiar | ✅ paridade; **ca488d18** consertou o toque em pane governado (espaço retido morria na lane crua) |
| **Captura** | chunks de 4700ms (OBSERVED); VAD/limiares UNKNOWN | VAD silero (threshold .5, minSpeech 300ms, maxSilence 800ms) + AEC3 wasm | ✅ Nexus ≥; sem cópia necessária |
| **ASR** | Groq whisper-large-v3 cloud, language pt, prompt de domínio (OBSERVED) | Groq whisper-large-v3-turbo + fallback OpenAI + whisper.cpp local; swap turbo→v3 no /translations | ✅ paridade+; **P2**: prompt de domínio no request (Overclock faz — melhora nomes: Nexus, Claude, MCP…) |
| **Pós-processo (MODO)** | `outputMode: english` — tradução otimizada p/ execução ANTES de entregar; modos PT-verbatim/EN-execução (OBSERVED+ATTESTED pela própria instrução injetada do ClockVoice) | Modo existia na config mas o ditado não mandava `translate` explícito → resultado dependia do engine que atendeu (fallback caía em PT) | ✅ **d23ae49c**: `dictationOutputMode` explícito por turno + seletor em Configurações › Voz ("Saída do ditado") |
| **Inject** | Texto comum no input do agente, one-way, sem handshake (ATTESTED) | Entrega CONFIRMADA com recibo, lane do operador p/ pane governado (61f91fb1) — voice.log 06/08 13:12Z prova `ptyConfirmed lane=operator` ao vivo | ✅ Nexus EXCEDE (recibo > fire-and-forget); manter |
| **HUD** | Indicador apenas; texto vai pro pane (ATTESTED) | HUD indica; texto vai pro pane | ✅ paridade; **P2**: mostrar o MODO ativo no HUD (chip "EN/PT") |

## Pendências especificadas (não-hotfix)

1. **Prompt de domínio no ASR** (S): passar `prompt` com vocabulário Nexus no transcribe/translate — campo já aceito pelo endpoint; hoje só a wake-word usa prompt.
2. **Chip de modo no HUD** (S): exibir EN/PT no HUD do ditado com toggle rápido.
3. **Transcript cru preservado no modo EN** (M): `/audio/translations` devolve só EN; preservar PT exigiria transcrição dupla (custo/latência) — registrar o texto final + modo no voice.log (feito) e reavaliar demanda.
4. **targetWpm/interactionMode** (P3): campos do Overclock sem equivalente claro; efeito real UNKNOWN — não copiar às cegas.

## Regressões corrigidas nesta lane (0.26.2)

- **ca488d18** — toque de Espaço em pane governado: espaço retido roteia pela lane do teclado (`paneInputLane`); probe verde não espelhava o caminho real (lição registrada no commit).
- **d23ae49c** — modo de saída do ditado explícito por turno + UI.
- (0.26.1, já vivo) **61f91fb1** — entrega confirmada via lane do operador, provada no voice.log de 06/08.

# JARVIS — detecção inteligente de permissão de microfone

## Problema

Depois de reinstalar/atualizar o app, o macOS **reseta** a permissão de microfone (TCC). O macOS então entrega **áudio mudo (zeros)** ao `getUserMedia` — sem erro, sem popup, sem sinal. A JARVIS fica surda sem nenhum feedback ao usuário. Incidente real: install do v0.10.2 → orb flat, nenhuma detecção de wake, zero erro no `voice.log` além de `mic.started`/`framesStart`/`engineReady`.

**Restrição do macOS:** um app só consegue disparar o popup nativo de mic quando o estado é `prompt` (indefinido). Após uma negação explícita (`denied`), o app **não** força re-prompt — só resta deep-linkar pra Ajustes do Sistema.

## Objetivo

A JARVIS detecta que não está ouvindo (permissão faltando **ou** captura silenciosa) e resolve proativamente: auto-pede quando possível; senão, mostra um banner acionável.

## Detecção (renderer)

Dois sinais independentes:

1. **Estado de permissão** via `navigator.permissions.query({ name: 'microphone' })`:
   - no boot do wake;
   - no foco/visibilidade da janela (permissão pode mudar em Ajustes enquanto o app roda).
   - → `granted | prompt | denied`.
2. **Watchdog de RMS** (reaproveita `onLevel`/`rmsToLevel` existentes): se o wake mic está "on" mas o RMS fica abaixo de `NOISE_FLOOR` por `> SILENT_THRESHOLD_MS` (12 s) → `silent`. Pega "permissão ok mas dispositivo mudo/morto" (ex.: fifine no mute físico).

Saúde derivada do mic (função pura, TDD): `classifyMicHealth(permissionState, silentMs): 'ok' | 'needsPermission' | 'silent'`.

## Matriz de ação

| micHealth | Ação |
|---|---|
| `ok` | nada |
| `needsPermission` (`prompt`) | **Auto** `getUserMedia` → dispara popup nativo do macOS (opção A aprovada). Se ainda mudo 8 s depois → banner. |
| `needsPermission` (`denied`) | Banner "Microfone bloqueado" + botão **[Abrir ajustes de mic]** → IPC `voice:openMicSettings` → main `open x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` |
| `silent` (`granted`, sem áudio) | Banner "Não estou ouvindo nada (mic mudo?)" + botão **[Abrir ajustes de som]** → IPC `voice:openSoundSettings` → main abre painel de entrada de som |

Banner é dispensável, mas reaparece se a condição persistir no próximo ciclo de detecção.

## Superfícies / arquivos

- `wake-mic.ts` — query de permissão + watchdog silencioso de RMS.
- `wake-health.ts` (novo, **puro**) — `classifyMicHealth`, `isSilent` (TDD).
- `voice-controller.ts` — wire detecção → store; auto-`getUserMedia` quando `prompt`.
- `voice-store.ts` — novo `micHealth: MicHealth` + setter.
- `VoiceHud.tsx` — banner com botões de ação (estética pixel/operador existente).
- `shared/voice-channels.ts` + `shared/voice-ipc.ts` + `shared/types.ts` + `preload.ts` — IPC `openMicSettings`, `openSoundSettings`.
- `main/voice/voice-ipc.ts` — handlers fazem `open` pros deep-links.
- `voice-log` — logar `mic.permission:{state}`, `mic.silentDetected`, `mic.promptTriggered`.

## Testes

- TDD (puro): `classifyMicHealth`, `isSilent`.
- `npm run typecheck` verde; suite de voz atual sem regressão.

## Não-goais (YAGNI)

- Sem mudar o gate RMS por-utterance (lógica de `trackUtterance` intocada).
- Sem tuning de threshold do wake.
- Sem seletor de dispositivo no-app (só deep-link pros ajustes do macOS).

## Rollout

v0.10.5 → rebuild + notarização local (receita `nexus-notary`) → release. (0.10.3 e 0.10.4 já saíram por outras sessões.) No boot do fresh install, permissão estará `prompt` → o próprio feature auto-dispara o popup → a regressão que causou este spec vira self-healing.

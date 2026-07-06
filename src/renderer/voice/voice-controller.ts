import { useEffect, useRef } from 'react';
import { useVoiceStore } from './voice-store';
import { markVictory } from '../state/onboarding-store';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { VoiceCapture } from './voice-capture';
import { WakeMic } from './wake-mic';
import { LiveAudioPlayer, micFrameToBase64 } from './live-audio';
import { stripPromptEcho } from './response-echo';
import { getPaneSessionId, writeToPane } from '../terminal/terminal-host';
import { listPanes } from '../lib/split-tree';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { launchSquadMission } from '../orch/mission-launcher';
import type { AutoStopOptions } from './voice-capture';
import type {
  JarvisAction,
  JarvisTurn,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';

/**
 * The Jarvis pipeline, renderer side. Wires the global PTT edges to:
 *   capture mic → transcribe+translate (main) → inject into focused pane →
 *   capture the agent's reply → speak it back (main TTS).
 *
 * Mounted once from App. All work is guarded so a missing mic / key / pane
 * surfaces a clear status instead of throwing.
 */

const RESPONSE_QUIET_MS = 1_500; // speak once the pane has been quiet this long
const RESPONSE_MAX_MS = 20_000; // hard cap on how long we wait for a reply
const MIN_SPEECH_SEC = 0.25;

/**
 * Frases que o Whisper cospe em áudio SEM fala (créditos de YouTube no corpus
 * de treino). Sozinhas, são quase sempre alucinação de silêncio — não turno.
 */
const WHISPER_GHOSTS = new Set([
  'you', 'thank you', 'thanks', 'thank you.', 'thanks for watching',
  'thanks for watching!', 'you.', 'bye', 'bye.', '.', 'obrigado',
  'obrigado.', 'obrigado por assistir', 'valeu', 'tchau', 'até a próxima',
  'legendas pela comunidade amara.org', 'amara.org',
]);

function isWhisperHallucination(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (clean.length === 0) return true;
  return WHISPER_GHOSTS.has(clean);
} // ignore accidental taps shorter than this
const WAKE_SILENCE_MS = 700; // wake-word capture: quiet time that ends the utterance
const WAKE_MAX_MS = 15_000; // wake-word capture: hard cap
const JARVIS_MEMORY_MS = 240_000; // 4 min: conversa continua sem recomeçar do zero

// Memória curta da conversa com a JARVIS (renderer-local, por janela).
let jarvisHistory: JarvisTurn[] = [];
const wakeMic = new WakeMic();
// Player do áudio realtime (Gemini Live): só instanciado sob demanda.
let livePlayer: LiveAudioPlayer | null = null;
function ensureLivePlayer(): LiveAudioPlayer {
  return (livePlayer ??= new LiveAudioPlayer());
}
let jarvisLastTurnAt = 0;

const WAKE_ACKS = ['Pois não?', 'Sim?', 'Às ordens.', 'Diga.'];
// Micro-fillers ditos NA HORA em que você termina de falar (enquanto STT +
// cérebro rodam) — latência percebida ~zero, estilo "Right away, sir".
const THINK_FILLERS = ['Deixa comigo.', 'Um instante.', 'Certo.', 'Já vejo.'];

// Acks pré-sintetizados (LiveKit playbook: cached greetings) — a resposta ao
// chamado sai INSTANTÂNEA, sem HTTP de TTS por wake.
const ackCache = new Map<string, { audioBase64: string; format: string }>();
let ackWarmed = false;

function isJarvisLiveEnabled(): boolean {
  const info = useVoiceStore.getState().info;
  return Boolean(info?.jarvisLive.enabled && info.routing === 'jarvis');
}

/** Transporte realtime (áudio full-duplex Gemini Live) ligado? */
function isRealtimeLive(): boolean {
  const info = useVoiceStore.getState().info;
  return isJarvisLiveEnabled() && info?.jarvisLive.transport === 'gemini-live';
}

function liveStatus(
  status: 'dormant' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error',
  error?: string,
): void {
  if (!isJarvisLiveEnabled()) return;
  void window.nexus.voice.liveStatus({ status, ...(error ? { error } : {}) });
}

function liveEndTurn(): void {
  if (!isJarvisLiveEnabled()) return;
  void window.nexus.voice
    .liveEndTurn()
    .then((state) => useVoiceStore.getState().setLiveState(state))
    .catch(() => {});
}

function warmAckCache(): void {
  if (ackWarmed) return;
  ackWarmed = true;
  for (const text of [...WAKE_ACKS, ...THINK_FILLERS]) {
    void window.nexus.voice
      .speak({ text, speakMode: 'full' })
      .then((r) => {
        if (r.ok && r.mode === 'audio') {
          ackCache.set(text, { audioBase64: r.audioBase64, format: r.format });
        }
      })
      .catch(() => {});
  }
}

/** Auto-stop padrão das capturas iniciadas por voz (sem tecla de soltar). */
function wakeAutoStop(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): AutoStopOptions {
  return {
    silenceMs: WAKE_SILENCE_MS,
    maxMs: WAKE_MAX_MS,
    onAutoStop: () => {
      if (isListening(capture)) void finishAndProcess(capture, busy);
    },
  };
}

export function useVoiceController(): void {
  const capture = useRef<VoiceCapture | null>(null);
  const busy = useRef(false);
  // Trava de narração proativa: garante uma fala ambiente por vez (anti-eco de
  // duas vozes sobrepostas).
  const narratingRef = useRef(false);

  useEffect(() => {
    capture.current = new VoiceCapture();
    const store = useVoiceStore.getState();

    // Wake word ("Jarvis"): detection → ela RESPONDE ao chamado ("Pois não?")
    // e então abre a escuta hands-free (auto-stop por silêncio).
    const onWake = () => {
      markVictory('voiceEnabled'); // usou a voz ao menos uma vez
      if (isListening(capture.current)) return; // já ouvindo você
      // BARGE-IN: corta qualquer fala/fila dela na hora do chamado.
      stopAllPlayback();
      if (busy.current) {
        // Estava FALANDO? Interrompe e volta a ouvir. Pensando (stt/cérebro,
        // <1s)? Deixa terminar — chame de novo em seguida.
        if (useVoiceStore.getState().status !== 'speaking') return;
        busy.current = false;
      }
      // Fluidez: a escuta abre IMEDIATAMENTE; o ack toca em paralelo (o
      // echoCancellation do mic filtra a própria voz dela).
      void beginListening(capture.current!, wakeAutoStop(capture.current!, busy), 'wake');
      const ack = WAKE_ACKS[Math.floor(Math.random() * WAKE_ACKS.length)];
      const cached = ackCache.get(ack);
      if (cached) {
        void playAudioBase64(cached.audioBase64, cached.format).catch(() => {});
      } else {
        void window.nexus.voice
          .speak({ text: ack, speakMode: 'full' })
          .then((r) => {
            if (r.ok && r.mode === 'audio') {
              ackCache.set(ack, { audioBase64: r.audioBase64, format: r.format });
              void playAudioBase64(r.audioBase64, r.format).catch(() => {});
            }
          })
          .catch(() => {});
      }
    };
    const syncWakeWord = (info: VoiceRuntimeInfo) => {
      if (info.enabled && info.wakeWordEnabled) {
        warmAckCache();
        void wakeMic.start().catch((err) => {
          useVoiceStore
            .getState()
            .setError(`Wake word indisponível: ${errMsg(err)}`);
        });
      } else {
        wakeMic.stop();
      }
    };

    void window.nexus.voice.getInfo().then((info) => {
      store.setInfo(info);
      syncWakeWord(info);
    });
    const unsubInfo = window.nexus.voice.onInfoChanged((info: VoiceRuntimeInfo) => {
      useVoiceStore.getState().setInfo(info);
      syncWakeWord(info);
    });
    const unsubLiveState = window.nexus.voice.onLiveState((state) => {
      useVoiceStore.getState().setLiveState(state);
    });
    const unsubLiveTranscript = window.nexus.voice.onLiveTranscript((event) => {
      useVoiceStore.getState().addLiveTranscript(event);
    });
    const unsubLiveToolCall = window.nexus.voice.onLiveToolCall((event) => {
      useVoiceStore.getState().setLiveTool(event);
    });
    const unsubLiveToolResult = window.nexus.voice.onLiveToolResult((event) => {
      useVoiceStore.getState().setLiveTool(event);
    });
    const unsubLiveInterrupted = window.nexus.voice.onLiveInterrupted((event) => {
      useVoiceStore.getState().setLiveInterrupted(event);
      // barge-in do servidor realtime: corta o áudio que está tocando.
      livePlayer?.stop();
    });
    // Áudio realtime (Gemini Live TTS 24 kHz) → toca em fila contínua.
    const unsubLiveAudio = window.nexus.voice.onLiveAudioOut((b64) => {
      ensureLivePlayer().play(b64);
    });
    // Espelha o mic para o transporte realtime enquanto o comando é falado.
    wakeMic.setUtteranceFrameTap((frame, sampleRate) => {
      if (isRealtimeLive()) {
        window.nexus.voice.liveMicIn(micFrameToBase64(frame, sampleRate));
      }
    });

    const onStart = () => {
      if (busy.current) return;
      void beginListening(capture.current!, undefined, 'ptt');
    };
    const onStop = () => {
      if (!isListening(capture.current)) return;
      void finishAndProcess(capture.current!, busy);
    };

    // Toggle: o renderer decide — capturando? envia. Senão, começa a ouvir.
    const onToggle = () => {
      if (isListening(capture.current)) {
        onStop();
      } else {
        stopAllPlayback();
        if (busy.current && useVoiceStore.getState().status === 'speaking') {
          busy.current = false;
        }
        void beginListening(capture.current!, undefined, 'manual');
      }
    };

    const unsubStart = window.nexus.voice.onPttStart(onStart);
    const unsubStop = window.nexus.voice.onPttStop(onStop);
    const unsubToggle = window.nexus.voice.onPttToggle(onToggle);
    const unsubWake = window.nexus.voice.onWakeDetected(onWake);
    // Narração proativa (handoff entregue/travado): fala só quando não há
    // turno de voz em andamento — aviso ambiente nunca atropela a conversa. É
    // SERIALIZADA (narratingRef): uma narração por vez, nunca duas vozes
    // sobrepostas. Marca 'speaking' enquanto fala para bloquear turnos e
    // narrações concorrentes; cancela qualquer playback pendente antes.
    const unsubNarrate = window.nexus.voice.onNarrate(({ text }) => {
      const status = useVoiceStore.getState().status;
      if (status !== 'idle' || narratingRef.current) {
        console.log('[voice] narração pulada (ocupado):', text.slice(0, 60));
        return;
      }
      narratingRef.current = true;
      const store = useVoiceStore.getState();
      store.setStatus('speaking');
      stopAllPlayback();
      void (async () => {
        try {
          const spoken = await window.nexus.voice.speak({ text, speakMode: 'full' });
          if (spoken.ok && spoken.mode === 'audio') {
            await playAudioBase64(spoken.audioBase64, spoken.format);
          }
        } catch (err) {
          console.warn('[voice] narração falhou:', err);
        } finally {
          narratingRef.current = false;
          if (useVoiceStore.getState().status === 'speaking') {
            useVoiceStore.getState().setStatus('idle');
          }
        }
      })();
    });

    return () => {
      unsubInfo();
      unsubStart();
      unsubStop();
      unsubToggle();
      unsubWake();
      unsubNarrate();
      unsubLiveState();
      unsubLiveTranscript();
      unsubLiveToolCall();
      unsubLiveToolResult();
      unsubLiveInterrupted();
      unsubLiveAudio();
      wakeMic.setUtteranceFrameTap(null);
      livePlayer?.dispose();
      livePlayer = null;
      wakeMic.stop();
    };
  }, []);
}

async function beginListening(
  capture: VoiceCapture,
  autoStop?: import('./voice-capture').AutoStopOptions,
  reason: 'manual' | 'wake' | 'ptt' | 'reply' = 'manual',
): Promise<void> {
  const store = useVoiceStore.getState();
  try {
    store.setNote(null);
    if (isJarvisLiveEnabled()) {
      const state = await window.nexus.voice.liveStart({ reason });
      store.setLiveState(state);
    }
    if (wakeMic.isRunning()) {
      // Stream do wake já está quente → escuta INSTANTÂNEA, sem getUserMedia.
      wakeMic.beginUtterance(autoStop);
    } else {
      await capture.start(autoStop);
    }
    store.setStatus('listening');
    liveStatus('listening');
  } catch (err) {
    store.setError(`Mic unavailable: ${errMsg(err)}`);
    liveStatus('error', errMsg(err));
  }
}

/** Está escutando por QUALQUER backend (mic quente do wake ou captura própria)? */
function isListening(capture: VoiceCapture | null): boolean {
  return Boolean(capture?.isCapturing() || wakeMic.isUtteranceActive());
}

async function finishAndProcess(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  busy.current = true;
  try {
    // Modo realtime: os frames já subiram ao vivo pelo tap do mic; aqui só
    // fechamos o turno de fala. O transporte devolve STT+resposta+áudio; o
    // pipeline batch (transcribe→brain→speak) NÃO roda.
    if (isRealtimeLive()) {
      if (wakeMic.isUtteranceActive()) wakeMic.finishUtterance();
      liveEndTurn();
      store.setStatus('idle');
      return;
    }
    const result = wakeMic.isUtteranceActive()
      ? wakeMic.finishUtterance()
      : await capture.stop();
    if (
      !result.wavBase64 ||
      result.durationSec < MIN_SPEECH_SEC ||
      result.heardSpeech === false
    ) {
      if (result.heardSpeech === false) {
        console.log('[voice] captura sem fala real (silêncio/ruído) — descartada');
      }
      store.setStatus('idle');
      liveEndTurn();
      return;
    }

    const routing = store.info?.routing ?? 'focused-pane';

    // Feedback INSTANTÂNEO: um micro-filler do cache cobre o tempo de
    // STT+cérebro (fire-and-forget; echoCancellation filtra do próximo turno).
    if (routing === 'jarvis') {
      const filler = THINK_FILLERS[Math.floor(Math.random() * THINK_FILLERS.length)];
      const cached = ackCache.get(filler);
      if (cached) void playAudioBase64(cached.audioBase64, cached.format).catch(() => {});
    }

    const tTurn = Date.now();
    store.setStatus('transcribing');
    if (routing === 'jarvis' && isJarvisLiveEnabled()) {
      liveStatus('thinking');
    }
    const stt = await window.nexus.voice.transcribe({
      audioBase64: result.wavBase64,
      mime: 'audio/wav',
      sampleRate: result.sampleRate,
      // Modo JARVIS conversa em PT — transcreve cru, sem traduzir para EN.
      ...(routing === 'jarvis' ? { translate: false, language: 'pt' } : {}),
    });
    if (!stt.ok) {
      store.setError(stt.error);
      liveStatus('error', stt.error);
      return;
    }
    // Eco do próprio TTS captado pelo mic (detectado no main via janela do que
    // acabou de ser falado) — descarte silencioso, mesmo tratamento do ghost.
    if (stt.discarded === 'echo') {
      console.log(`[voice] eco do TTS descartado: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    const tStt = Date.now() - tTurn;
    // Whisper ALUCINA frases fixas em silêncio/ruído ("you", "thank you",
    // "obrigado por assistir"…). Elas passam o gate de RMS quando há um
    // sussurro — descarta antes de virar turno (a JARVIS falando sozinha).
    if (isWhisperHallucination(stt.text)) {
      console.log(`[voice] transcrição-lixo do Whisper descartada: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    store.setTranscript(stt.text);
    console.log(`[voice] transcrito (${tStt}ms): "${stt.text}"`);
    // Surface throttle/quota fallbacks instead of failing silently.
    store.setNote(stt.fallbackNote ?? null);

    if (routing === 'jarvis') {
      await runJarvisTurn(stt.text, capture, busy);
      return;
    }

    store.setStatus('routing');
    const paneId = routePrompt(stt.text);
    if (!paneId) {
      store.setError('No focused pane to route the prompt into.');
      return;
    }

    // Jarvis: capture the agent's reply, then speak a condensed summary. The
    // transcribed prompt is passed so its PTY echo is stripped before speaking.
    const reply = await captureResponse(paneId, stt.text);
    if (reply.trim()) {
      store.setStatus('speaking');
      const spoken = await window.nexus.voice.speak({ text: reply });
      if (spoken.ok) {
        if (spoken.mode === 'audio') await playAudioBase64(spoken.audioBase64, spoken.format);
        store.setSpoken(reply);
      } else {
        store.setError(spoken.error);
        return;
      }
    }
    store.setStatus('idle');
  } catch (err) {
    store.setError(errMsg(err));
    liveStatus('error', errMsg(err));
  } finally {
    busy.current = false;
  }
}

/**
 * Um turno da conversa com a JARVIS: fala transcrita → cérebro (main) →
 * executa a ação no app → fala a resposta → se ela terminou perguntando,
 * reabre a escuta sozinha (o loop "viva").
 */
async function runJarvisTurn(
  transcript: string,
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  const now = Date.now();
  if (now - jarvisLastTurnAt > JARVIS_MEMORY_MS) jarvisHistory = [];
  jarvisLastTurnAt = now;

  const { root, focusedPaneId } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchPaneId = findOrchestratorPane(root);
  const orchPane = panes.find((p) => p.id === orchPaneId) ?? null;
  const context = {
    workspace: useWorkspaceStore.getState().current?.name ?? null,
    recents: useWorkspaceStore.getState().recents.map((r) => r.name).slice(0, 10),
    squads: useOrchStore.getState().squads.map((s) => s.name),
    panes: panes
      .map((p) => {
        const tag =
          p.id === orchPaneId
            ? '[orquestrador] '
            : p.kind === 'shell'
              ? '[shell] '
              : '[agente] ';
        return `${tag}${p.title}`;
      })
      .slice(0, 20),
    focusedPane: panes.find((p) => p.id === focusedPaneId)?.title ?? null,
    orchestrator: orchPane?.title ?? null,
    missions: useOrchStore
      .getState()
      .missions.filter((m) => m.status !== 'done')
      .map((m) => `${m.title} (${m.status})`)
      .slice(0, 10),
  };

  store.setStatus('routing');
  const tBrain = Date.now();
  const reply = await window.nexus.voice.jarvis({
    transcript,
    context,
    history: jarvisHistory,
  });
  console.log(`[voice] cérebro: ${Date.now() - tBrain}ms`);
  jarvisHistory.push({ role: 'user', content: transcript });
  jarvisHistory.push({ role: 'assistant', content: reply.say });
  const maxTurns = isJarvisLiveEnabled()
    ? (useVoiceStore.getState().info?.jarvisLive.maxWindowTurns ?? 12)
    : 10;
  if (jarvisHistory.length > maxTurns * 2) {
    jarvisHistory = jarvisHistory.slice(-(maxTurns * 2));
  }

  // Executa a ação decidida pelo cérebro.
  let sayText = reply.say;
  let toolResult: { tool: JarvisAction['type']; ok: boolean; summary: string } | null =
    reply.action.type === 'none'
      ? null
      : { tool: reply.action.type, ok: true, summary: 'executado' };
  if (reply.action.type === 'open_squad') {
    const wanted = reply.action.squadName.toLowerCase();
    const squads = useOrchStore.getState().squads;
    const match =
      squads.find((s) => s.name.toLowerCase() === wanted) ??
      squads.find(
        (s) =>
          s.name.toLowerCase().includes(wanted) ||
          wanted.includes(s.name.toLowerCase()),
      );
    console.log(
      `[voice] ação open_squad "${reply.action.squadName}" → ${match ? `match: ${match.name}` : 'SEM MATCH'}`,
    );
    if (match && !useWorkspaceStore.getState().current) {
      sayText =
        'Antes eu preciso de um projeto aberto. Quer que eu abra um dos ' +
        'recentes? Diga o nome.';
      reply.expectReply = true;
      toolResult = { tool: reply.action.type, ok: false, summary: 'sem workspace aberto' };
    } else if (match) {
      // Voz = intenção de EXECUTAR: lança a missão na hora (orquestrador
      // spawna e recebe o kickoff), nada de wizard esperando clique.
      const adapters = await window.nexus.adapters.list();
      const res = launchSquadMission(match, adapters);
      console.log(`[voice] launch squad "${match.name}" → ${res.ok ? 'NO AR' : `falhou: ${res.error}`}`);
      if (!res.ok) sayText = res.error ?? 'Não consegui subir o squad.';
      toolResult = {
        tool: reply.action.type,
        ok: res.ok,
        summary: res.ok ? `squad ${match.name} iniciado` : (res.error ?? 'falhou'),
      };
    } else {
      sayText = `Não achei o squad "${reply.action.squadName}". Os disponíveis são: ${context.squads.join(', ')}.`;
      toolResult = { tool: reply.action.type, ok: false, summary: 'squad não encontrado' };
    }
  } else if (reply.action.type === 'open_workspace') {
    const wanted = reply.action.workspaceName.toLowerCase();
    const ws = useWorkspaceStore.getState();
    const all = [...ws.recents];
    const match =
      all.find((r) => r.name.toLowerCase() === wanted) ??
      all.find(
        (r) =>
          r.name.toLowerCase().includes(wanted) ||
          wanted.includes(r.name.toLowerCase()),
      );
    console.log(
      `[voice] ação open_workspace "${reply.action.workspaceName}" → ${match ? `match: ${match.name}` : 'SEM MATCH'}`,
    );
    if (match) {
      void ws.open(match.path);
      toolResult = { tool: reply.action.type, ok: true, summary: `workspace ${match.name} aberto` };
    } else {
      sayText = `Não achei o projeto "${reply.action.workspaceName}" nos recentes.`;
      toolResult = { tool: reply.action.type, ok: false, summary: 'workspace não encontrado' };
    }
  } else if (reply.action.type === 'design_squad') {
    const ws = useWorkspaceStore.getState().current;
    if (!ws) {
      sayText = 'Abre um projeto primeiro que eu monto o squad dele.';
      toolResult = { tool: reply.action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      console.log('[voice] ação design_squad → analisando workspace');
      void window.nexus.orch.designSquad(ws.path).then((res) => {
        if (res.ok && res.squad) {
          useMissionWizardStore.getState().openForSquad(res.squad.id);
          void window.nexus.voice.speak({
            text: `Squad ${res.squad.name} pronto — revise e inicie.`,
            speakMode: 'full',
          });
        } else {
          void window.nexus.voice.speak({
            text: `Não consegui montar o squad: ${res.error ?? 'erro'}.`,
            speakMode: 'full',
          });
        }
      });
      sayText = 'Deixa comigo — analisando o projeto para montar o time.';
      toolResult = { tool: reply.action.type, ok: true, summary: 'design de squad iniciado' };
    }
  } else if (reply.action.type === 'new_mission') {
    console.log('[voice] ação new_mission → abrindo wizard');
    useMissionWizardStore.getState().openForMission();
    toolResult = { tool: reply.action.type, ok: true, summary: 'wizard de missão aberto' };
  } else if (reply.action.type === 'send_to_pane') {
    // Missão dita por voz vai pro ORQUESTRADOR quando ele existe; senão, pro
    // pane focado.
    const { root: r2, focusedPaneId: f2 } = useLayoutStore.getState();
    const target = findOrchestratorPane(r2) ?? f2;
    const ok = target ? writeToPane(target, `${reply.action.text}\n`) : false;
    console.log(
      `[voice] ação send_to_pane → ${target ? (target === f2 ? 'pane focado' : 'ORQUESTRADOR') : 'NENHUM'}`,
    );
    if (!ok) sayText = 'Não tem nenhum pane para eu mandar a tarefa.';
    toolResult = {
      tool: reply.action.type,
      ok,
      summary: ok ? 'tarefa enviada ao pane' : 'nenhum pane disponível',
    };
  } else if (reply.action.type === 'run_command') {
    const command = reply.action.command;
    const { focusedPaneId: fp, root: rc } = useLayoutStore.getState();
    const focused = fp ? listPanes(rc).find((p) => p.id === fp) : undefined;
    if (!focused) {
      sayText = 'Não tem um terminal focado para eu rodar o comando.';
      toolResult = { tool: reply.action.type, ok: false, summary: 'sem pane focado' };
    } else if (focused.kind !== 'shell') {
      // SEC#6: run_command targets a real shell only, never an AI-agent pane.
      sayText = 'Foca um terminal shell que aí eu rodo o comando.';
      toolResult = { tool: reply.action.type, ok: false, summary: 'pane focado não é shell' };
    } else {
      // A shell command decided by the (LLM) brain NEVER auto-runs: a poisoned
      // transcript could inject one. Require an explicit, un-spoofable native
      // confirmation showing the exact command before it executes.
      const approved = await window.nexus.voice.confirmCommand(command);
      if (approved) {
        const ok = writeToPane(focused.id, `${command}\n`);
        if (!ok) sayText = 'Não consegui escrever no terminal.';
        console.log(`[voice] run_command "${command}" → ${ok ? 'confirmado + executado' : 'FALHOU'}`);
        toolResult = {
          tool: reply.action.type,
          ok,
          summary: ok ? 'comando confirmado e executado' : 'falha ao escrever no terminal',
        };
      } else {
        sayText = 'Cancelei, não rodei o comando.';
        console.log(`[voice] run_command "${command}" → RECUSADO pelo usuário`);
        toolResult = { tool: reply.action.type, ok: false, summary: 'usuário recusou' };
      }
    }
  }
  if (toolResult && isJarvisLiveEnabled()) {
    window.nexus.voice.liveToolResult(toolResult);
  }

  store.setStatus('speaking');
  liveStatus('speaking');
  // Pipelining por sentença (LiveKit playbook): sintetiza e toca a PRIMEIRA
  // frase enquanto o resto ainda está sendo gerado — corta o time-to-first-audio.
  const split = splitFirstSentence(sayText);
  const tTts = Date.now();
  const restPromise = split.rest
    ? window.nexus.voice.speak({ text: split.rest, speakMode: 'full' })
    : null;
  const first = await window.nexus.voice.speak({ text: split.first, speakMode: 'full' });
  console.log(`[voice] tts 1ª frase: ${Date.now() - tTts}ms`);
  if (first.ok) {
    if (first.mode === 'audio') await playAudioBase64(first.audioBase64, first.format);
  } else {
    store.setError(first.error);
    return;
  }
  if (restPromise) {
    const rest = await restPromise;
    if (rest.ok && rest.mode === 'audio') {
      await playAudioBase64(rest.audioBase64, rest.format);
    }
  }
  store.setSpoken(sayText);
  store.setStatus('idle');

  // A fala chegou até aqui = passou pelo wake (≥0.6), pelo gate de silêncio e
  // pelo filtro de alucinação, então é conversa REAL. Reabre a escuta sempre
  // que ela quiser resposta — sem teto de turnos (a trava antiga cortava a
  // conversa na 2ª troca). O silêncio encerra sozinho: se o usuário não
  // responder, a próxima captura vem sem fala (heardSpeech=false) e não reabre.
  const wantsReply =
    isJarvisLiveEnabled() || reply.expectReply || sayText.trim().endsWith('?');
  if (wantsReply) {
    busy.current = false;
    void beginListening(capture, wakeAutoStop(capture, busy), 'reply');
  } else {
    liveEndTurn();
  }
}

/** Primeira sentença (mín. 12 chars) + resto — para o TTS pipelined. */
function splitFirstSentence(text: string): { first: string; rest: string } {
  const t = text.trim();
  const m = /[.!?…](\s|$)/.exec(t.slice(12));
  if (!m || m.index + 13 >= t.length) return { first: t, rest: '' };
  const cut = 12 + m.index + 1;
  return { first: t.slice(0, cut).trim(), rest: t.slice(cut).trim() };
}

/**
 * Inject the transcribed prompt into the target pane's PTY (same path as typing).
 * Returns the pane id used, or null when nothing is focused. Routing modes other
 * than 'focused-pane' currently resolve to the focused pane (orchestrator routing
 * arrives with the MCP squad work in a later phase).
 */
function routePrompt(text: string): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  const routing = useVoiceStore.getState().info?.routing ?? 'focused-pane';
  const targetPaneId =
    routing === 'orchestrator'
      ? findOrchestratorPane(root) ?? focusedPaneId
      : focusedPaneId;
  if (!targetPaneId) return null;
  const ok = writeToPane(targetPaneId, `${text}\n`);
  return ok ? targetPaneId : null;
}

function findOrchestratorPane(root: ReturnType<typeof useLayoutStore.getState>['root']): string | null {
  const panes = listPanes(root);
  const pane = panes.find(
    (p) => p.orchRequestId?.startsWith('squad-') || /(^|[ ·])orq\b/i.test(p.title),
  );
  return pane?.id ?? null;
}

/**
 * Accumulate the pane's PTY output after injection and resolve with the agent's
 * reply. End-of-turn is detected by three signals, strongest first:
 *   1. The pane returns from 'busy' → 'idle' (tracked by phase 2b via
 *      useSessionStateStore). This is the reliable signal for TUI agents like
 *      Claude Code / Codex that continuously redraw a spinner and so never fall
 *      quiet — pure silence detection would always hit the hard cap and speak a
 *      truncated dump.
 *   2. The PTY has been quiet for RESPONSE_QUIET_MS (non-agent panes that emit no
 *      idle/busy state events).
 *   3. RESPONSE_MAX_MS hard cap.
 * The captured buffer starts with the PTY echo of the injected prompt (plus
 * spinner); `promptEcho` is stripped so we speak the RESPONSE, not the command.
 */
function captureResponse(paneId: string, promptEcho: string): Promise<string> {
  return new Promise((resolve) => {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      resolve('');
      return;
    }
    let buffer = '';
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let sawBusy = false;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardCap);
      unsubData();
      unsubState();
      resolve(stripPromptEcho(buffer, promptEcho));
    };

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, RESPONSE_QUIET_MS);
    };

    const unsubData = window.nexus.pty.onData(sessionId, (data) => {
      buffer += data;
      armQuiet();
    });
    // Strong end-of-turn signal: finish as soon as the pane goes back to 'idle'
    // after having been 'busy'. Falls back to the quiet timer for panes that
    // never report state (no cli-agent adapter tracking them).
    const unsubState = useSessionStateStore.subscribe((s) => {
      const state = s.paneStates.get(paneId);
      if (state === 'busy') sawBusy = true;
      else if (state === 'idle' && sawBusy) finish();
    });
    const hardCap = setTimeout(finish, RESPONSE_MAX_MS);
    armQuiet();
  });
}

/** Decode + play TTS audio bytes via Web Audio. */
// ── Controlador central de reprodução (barge-in) ────────────────────────────
// Toda fala dela passa por aqui. Um novo "Hey Jarvis" corta o áudio atual E
// invalida reproduções pendentes (geração) — sem isso, respostas antigas
// enfileiradas vazavam no chamado seguinte ("ela chega agradecendo").
let playbackGen = 0;
let liveSources: AudioBufferSourceNode[] = [];

function stopAllPlayback(): void {
  if (isJarvisLiveEnabled() && useVoiceStore.getState().status === 'speaking') {
    void window.nexus.voice.liveInterrupt('barge-in');
  }
  playbackGen += 1;
  for (const src of liveSources) {
    try {
      src.stop();
    } catch {
      // já parado
    }
  }
  liveSources = [];
}

async function playAudioBase64(base64: string, _format: string): Promise<void> {
  const gen = playbackGen;
  const bytes = base64ToBytes(base64);
  const ctx = new AudioContext();
  try {
    // Fresh Uint8Array → its buffer is a plain ArrayBuffer (not shared).
    const arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (gen !== playbackGen) return; // barge-in aconteceu enquanto decodificava
    const source = ctx.createBufferSource();
    liveSources.push(source);
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    liveSources = liveSources.filter((s) => s !== source);
  } finally {
    void ctx.close();
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

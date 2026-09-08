import { useEffect, useRef, useState } from 'react';
import { useVoiceStore, type VoiceUiStatus } from '../voice/voice-store';
import { useDictationMode } from '../voice/use-dictation-mode';
import {
  anchorFromDrag,
  clampHudDragPosition,
  hudPositionStyle,
  isHudMini,
} from '../voice/hud-prefs';
import { requestJarvisWake } from '../voice/manual-wake';
import { canAttemptRealtime } from '../voice/voice-realtime-gates';
import { realtimeMissingCredentialMessage } from './voice-settings-helpers';
import {
  powerOffJarvis,
  setResponseMuted,
  stopJarvisSpeech,
} from '../voice/response-output-gate';
import { PixelIcon } from './PixelIcon';
import { VoiceLevelBars } from './VoiceLevelBars';

/**
 * HUD flutuante da JARVIS: fase do pipeline ao vivo (ouvindo → transcrevendo →
 * enviando → falando), último transcript e erros. O orb reage à amplitude REAL
 * do mic (voice-store.level).
 *
 * Três modos (persistidos em hud-prefs):
 *  - expanded: painel compacto com orb + transcript, ARRASTÁVEL pelo cabeçalho
 *    e redimensionável pela alça lateral; solto, ancora no canto mais próximo.
 *  - mini: pill pequena (orb + fase) — arrastável; clique expande.
 *  - hidden: SÓ ÁUDIO — a voz funciona 100% sem visual (o pill VOX da
 *    WorkspaceBar continua mostrando o estado).
 */

const PHASE_LABEL: Record<Exclude<VoiceUiStatus, 'idle'>, string> = {
  listening: 'Ouvindo',
  transcribing: 'Transcrevendo',
  routing: 'Enviando ao pane',
  speaking: 'Falando',
  error: 'Erro de voz',
};

/** Estados do Jarvis Live → rótulo em PT. */
const LIVE_LABEL: Record<string, string> = {
  dormant: 'pronto',
  thinking: 'pensando',
  speaking: 'falando',
  listening: 'ouvindo',
  interrupted: 'interrompido',
};

/** Movimento menor que isto no pointerup = clique, não drag. */
const CLICK_SLOP_PX = 4;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface DragState {
  pointerId: number;
  /** Offset do ponteiro para a origem do elemento no início do drag. */
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
}

export function VoiceHud() {
  const status = useVoiceStore((s) => s.status);
  const transcript = useVoiceStore((s) => s.lastTranscript);
  const note = useVoiceStore((s) => s.note);
  const error = useVoiceStore((s) => s.error);
  const micHealth = useVoiceStore((s) => s.micHealth);
  const info = useVoiceStore((s) => s.info);
  const liveState = useVoiceStore((s) => s.liveState);
  const liveTool = useVoiceStore((s) => s.liveTool);
  const hud = useVoiceStore((s) => s.hud);
  const responseMuted = useVoiceStore((s) => s.responseMuted);
  const setHudMode = useVoiceStore((s) => s.setHudMode);
  const setHudAnchor = useVoiceStore((s) => s.setHudAnchor);
  const setHudWidth = useVoiceStore((s) => s.setHudWidth);

  // Posição transitória durante o drag (left/top absolutos); null = ancorado.
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );

  const liveStatus = liveState?.status ?? 'dormant';
  // Chip CODE/CHAT no titlebar (paridade Bridge): mesmo controle do chip da
  // barra superior — useDictationMode centraliza estado + persistência.
  const {
    mode: dictationMode,
    label: dictationLabel,
    title: dictationTitle,
    toggle: toggleDictationMode,
  } = useDictationMode();
  const wakeBlockedPid = info?.wakeLockHolderPid ?? null;
  const wakeBlocked = info?.wakeWordEnabled === true && wakeBlockedPid !== null;
  const canClickWake = status === 'idle' && info?.enabled === true && !wakeBlocked;
  const missingRealtimeKey =
    info?.jarvisLive.enabled === true &&
    info.jarvisLive.transport !== 'classic' &&
    !canAttemptRealtime(info)
      ? realtimeMissingCredentialMessage(info.jarvisLive.transport)
      : null;
  const liveVisible =
    info?.jarvisLive.enabled === true &&
    liveState?.enabled !== false &&
    liveStatus !== 'off' &&
    (liveStatus !== 'dormant' || status === 'idle');

  // Amplitude do mic → CSS var no orb, imperativo (sem re-render por frame).
  const orbRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    return useVoiceStore.subscribe((s) => {
      orbRef.current?.style.setProperty('--voice-amp', s.level.toFixed(3));
    });
  }, []);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  if (hud.mode === 'hidden') return null; // só-áudio: zero visual
  if (
    status === 'idle' &&
    !liveVisible &&
    !wakeBlocked &&
    !canClickWake &&
    !missingRealtimeKey
  ) {
    return null;
  }

  const liveLabel = LIVE_LABEL[liveStatus] ?? liveStatus;
  const label = missingRealtimeKey
    ? 'Sem chave realtime'
    : wakeBlocked
      ? 'Wake ocupado'
      : canClickWake
        ? 'Jarvis pronta'
        : status === 'idle'
          ? `Jarvis ${liveLabel}`
          : PHASE_LABEL[status];
  const isError = status === 'error' || Boolean(missingRealtimeKey);
  const visibleError = error ?? missingRealtimeKey;
  const isMini = isHudMini(hud.mode);

  // In toggle mode the send edge is a SECOND keypress — say so, or users
  // hold-release and think voice broke.
  const listeningHint =
    status === 'listening' && info
      ? info.hotkeyMode === 'hold'
        ? `solte ${info.shortcut} para enviar`
        : `pressione ${info.shortcut} de novo para enviar`
      : null;

  const finishDrag = (pointerId: number) => {
    const drag = dragRef.current;
    const shell = shellRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    if (!shell) {
      setDragPos(null);
      return;
    }
    if (drag.moved) {
      const rect = shell.getBoundingClientRect();
      setHudAnchor(
        anchorFromDrag(
          { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    } else if (missingRealtimeKey || status === 'error') {
      useVoiceStore.getState().openSettings();
    } else if (canClickWake) {
      requestJarvisWake();
    } else if (isMini) {
      setHudMode('expanded');
    }
    setDragPos(null);
  };

  const beginDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const shell = shellRef.current;
    if (!shell || dragRef.current) return;
    e.preventDefault();
    const rect = shell.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    try {
      shell.setPointerCapture(e.pointerId);
    } catch {
      // Window listeners below are the source of truth — capture is optional.
    }

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId || !shellRef.current) return;
      if (
        Math.abs(ev.clientX - drag.startX) > CLICK_SLOP_PX ||
        Math.abs(ev.clientY - drag.startY) > CLICK_SLOP_PX
      ) {
        drag.moved = true;
      }
      if (!drag.moved) return;
      const box = shellRef.current.getBoundingClientRect();
      setDragPos(
        clampHudDragPosition(
          ev.clientX - drag.offsetX,
          ev.clientY - drag.offsetY,
          { width: box.width, height: box.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      finishDrag(ev.pointerId);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  };

  const beginResize = (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    resizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: hud.width,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const moveResize = (e: React.PointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== e.pointerId) return;
    // Alça na borda esquerda: ancorado à direita, arrastar para a esquerda
    // ALARGA; ancorado à esquerda, o inverso.
    const delta = e.clientX - resize.startX;
    const grow = hud.corner.endsWith('r') ? -delta : delta;
    setHudWidth(resize.startWidth + grow);
  };

  const endResize = (e: React.PointerEvent<HTMLElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) resizeRef.current = null;
  };

  const positionStyle = dragPos
    ? { left: dragPos.left, top: dragPos.top, right: 'auto', bottom: 'auto' }
    : hudPositionStyle(hud);

  const orb = (
    <div
      className={`voice-orb ${isMini ? 'voice-orb--mini' : ''}`}
      aria-hidden="true"
      ref={orbRef}
    >
      <span className="voice-orb__ring voice-orb__ring--outer" />
      {!isMini && <span className="voice-orb__ring voice-orb__ring--middle" />}
      {!isMini && <span className="voice-orb__ring voice-orb__ring--inner" />}
      <span className="voice-orb__core" />
      {!isMini && <span className="voice-orb__scan voice-orb__scan--a" />}
      {!isMini && <span className="voice-orb__scan voice-orb__scan--b" />}
    </div>
  );

  if (isMini) {
    return (
      <div
        ref={shellRef}
        className={`voice-hud voice-hud--mini voice-hud--${isError ? 'error' : status} ${dragPos ? 'voice-hud--dragging' : ''}`}
        style={positionStyle}
        role="status"
        aria-live="polite"
        title={
          visibleError
            ? `${visibleError} — clique para abrir as configurações, arraste para mover`
            : canClickWake
              ? 'JARVIS — clique para acordar, arraste para mover'
              : 'JARVIS — clique para expandir, arraste para mover'
        }
        onPointerDown={beginDrag}
      >
        {orb}
        <VoiceLevelBars visible={status === 'listening'} />
        <span className="voice-hud__mini-label">
          {missingRealtimeKey
            ? 'sem chave'
            : wakeBlocked
              ? 'wake ocupado'
              : isError
                ? 'erro'
                : responseMuted
                  ? 'muda'
                  : canClickWake
                    ? 'pronta'
                    : status === 'idle'
                      ? liveLabel
                      : PHASE_LABEL[status]}
        </span>
        <span className="voice-hud__ctls" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className={`voice-hud__ctl ${responseMuted ? 'voice-hud__ctl--active' : ''}`}
            title={
              responseMuted
                ? 'Ativar áudio das respostas'
                : 'Silenciar respostas (comandos seguem ativos)'
            }
            aria-label={
              responseMuted
                ? 'Ativar áudio das respostas da JARVIS'
                : 'Silenciar respostas da JARVIS'
            }
            aria-pressed={responseMuted}
            onClick={() => setResponseMuted(!responseMuted)}
          >
            <PixelIcon name={responseMuted ? 'volume-off' : 'volume'} size={12} />
          </button>
          <button
            className="voice-hud__ctl"
            title="Parar fala atual"
            aria-label="Parar fala atual da JARVIS"
            onClick={() => stopJarvisSpeech()}
          >
            <PixelIcon name="stop" size={12} />
          </button>
          <button
            className="voice-hud__ctl"
            title="Desligar sessão Jarvis"
            aria-label="Desligar sessão da JARVIS"
            onClick={() => void powerOffJarvis()}
          >
            <PixelIcon name="power" size={12} />
          </button>
          <button
            className="voice-hud__ctl"
            title="Ocultar (só áudio)"
            aria-label="Ocultar HUD da JARVIS (modo só áudio)"
            onClick={() => setHudMode('hidden')}
          >
            <PixelIcon name="close" size={12} />
          </button>
        </span>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={`voice-hud voice-hud--expanded voice-hud--${isError ? 'error' : status} ${dragPos ? 'voice-hud--dragging' : ''}`}
      style={{ ...positionStyle, width: hud.width }}
      role="status"
      aria-live="polite"
    >
      <div
        className="voice-hud__titlebar"
        title="Arraste para mover — solte perto de um canto para ancorar"
        onPointerDown={beginDrag}
      >
        <span className="voice-hud__grip" aria-hidden="true">
          <PixelIcon name="grip" size={12} />
        </span>
        <span className="voice-hud__eyebrow">
          {info?.jarvisLive.enabled ? 'JARVIS LIVE' : 'JARVIS'}
          {responseMuted ? ' · MUDA' : ''}
        </span>
        <span className="voice-hud__ctls">
          <button
            className={`voice-hud__ctl voice-hud__ctl--mode ${dictationMode === 'english' ? 'voice-hud__ctl--active' : ''}`}
            title={dictationTitle}
            aria-label="Alternar modo do ditado entre Code e Chat"
            aria-pressed={dictationMode === 'english'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void toggleDictationMode()}
          >
            {dictationLabel}
          </button>
          <button
            className={`voice-hud__ctl ${responseMuted ? 'voice-hud__ctl--active' : ''}`}
            title={
              responseMuted
                ? 'Ativar áudio das respostas'
                : 'Silenciar respostas (comandos seguem ativos)'
            }
            aria-label={
              responseMuted
                ? 'Ativar áudio das respostas da JARVIS'
                : 'Silenciar respostas da JARVIS'
            }
            aria-pressed={responseMuted}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setResponseMuted(!responseMuted)}
          >
            <PixelIcon name={responseMuted ? 'volume-off' : 'volume'} size={12} />
          </button>
          <button
            className="voice-hud__ctl"
            title="Parar fala atual"
            aria-label="Parar fala atual da JARVIS"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => stopJarvisSpeech()}
          >
            <PixelIcon name="stop" size={12} />
          </button>
          <button
            className="voice-hud__ctl"
            title="Desligar sessão Jarvis"
            aria-label="Desligar sessão da JARVIS"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void powerOffJarvis()}
          >
            <PixelIcon name="power" size={12} />
          </button>
          <button
            className="voice-hud__ctl"
            title="Minimizar (pill)"
            aria-label="Minimizar HUD da JARVIS"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setHudMode('mini')}
          >
            <PixelIcon name="minimize" size={12} />
          </button>
          <button
            className="voice-hud__ctl"
            title="Ocultar (só áudio)"
            aria-label="Ocultar HUD da JARVIS (modo só áudio)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setHudMode('hidden')}
          >
            <PixelIcon name="close" size={12} />
          </button>
        </span>
      </div>
      <div className="voice-hud__shell">
        {orb}
        <VoiceLevelBars visible={status === 'listening'} />
        <div className="voice-hud__body">
          <span className="voice-hud__label">{label}</span>
          {visibleError ? (
            <span className="voice-hud__detail voice-hud__detail--error">{visibleError}</span>
          ) : (
            <>
              {wakeBlocked && (
                <span className="voice-hud__detail voice-hud__detail--error">
                  Outra instância do NexusIDE está ouvindo “Hey Jarvis” (PID {wakeBlockedPid}).
                  Feche a outra instância ou reinicie o app.
                </span>
              )}
              {transcript && <span className="voice-hud__detail">"{transcript}"</span>}
              {info?.jarvisLive.enabled && liveState && (
                <span className="voice-hud__detail voice-hud__detail--note">
                  sessão {liveState.turns} turno{liveState.turns === 1 ? '' : 's'}
                  {liveTool ? ` · ${liveTool.summary}` : ''}
                </span>
              )}
              {listeningHint && (
                <span className="voice-hud__detail voice-hud__detail--note">
                  {listeningHint}
                </span>
              )}
              {note && (
                <span className="voice-hud__detail voice-hud__detail--note">
                  {'-> '}
                  {note}
                </span>
              )}
              {micHealth === 'needsPermission' && (
                <span className="voice-hud__detail voice-hud__detail--error">
                  Microfone sem permissão — a JARVIS não te ouve.
                  <button
                    type="button"
                    className="voice-hud__action"
                    onClick={() =>
                      navigator.mediaDevices
                        .getUserMedia({ audio: true })
                        .then((s) => s.getTracks().forEach((t) => t.stop()))
                        .catch(() => {})
                    }
                  >
                    Permitir
                  </button>
                  <button
                    type="button"
                    className="voice-hud__action"
                    onClick={() => window.nexus.voice.openMicSettings()}
                  >
                    Ajustes
                  </button>
                </span>
              )}
              {micHealth === 'phantomGrant' && (
                <span className="voice-hud__detail voice-hud__detail--error">
                  Permissão de mic fantasma — o macOS diz OK mas entrega silêncio.
                  <button
                    type="button"
                    className="voice-hud__action"
                    onClick={() => {
                      void window.nexus.voice.resetMicPermission().then((r) => {
                        if (!r.ok) {
                          useVoiceStore
                            .getState()
                            .setNote(`Reset falhou: ${r.error ?? 'erro desconhecido'}`);
                        }
                      });
                    }}
                  >
                    Resetar e reiniciar
                  </button>
                </span>
              )}
              {micHealth === 'silent' && (
                <span className="voice-hud__detail voice-hud__detail--error">
                  Não estou ouvindo nada — mic mudo ou dispositivo errado.
                  <button
                    type="button"
                    className="voice-hud__action"
                    onClick={() => window.nexus.voice.openSoundSettings()}
                  >
                    Ajustes de som
                  </button>
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <span
        className="voice-hud__resize"
        title="Arraste para redimensionar"
        aria-hidden="true"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </div>
  );
}

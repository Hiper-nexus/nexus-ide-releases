import { useEffect, useRef, useState } from 'react';
import { useVoiceStore, type VoiceUiStatus } from '../voice/voice-store';
import { anchorFromDrag, hudPositionStyle } from '../voice/hud-prefs';
import { requestJarvisWake } from '../voice/manual-wake';

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
  const setHudMode = useVoiceStore((s) => s.setHudMode);
  const setHudAnchor = useVoiceStore((s) => s.setHudAnchor);
  const setHudWidth = useVoiceStore((s) => s.setHudWidth);

  // Posição transitória durante o drag (left/top absolutos); null = ancorado.
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );

  const liveStatus = liveState?.status ?? 'dormant';
  const wakeBlockedPid = info?.wakeLockHolderPid ?? null;
  const wakeBlocked = info?.wakeWordEnabled === true && wakeBlockedPid !== null;
  const canClickWake = status === 'idle' && info?.enabled === true && !wakeBlocked;
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

  if (hud.mode === 'hidden') return null; // só-áudio: zero visual
  if (status === 'idle' && !liveVisible && !wakeBlocked && !canClickWake) return null;

  const liveLabel = LIVE_LABEL[liveStatus] ?? liveStatus;
  const label = wakeBlocked
    ? 'Wake word preso'
    : canClickWake
      ? 'Jarvis pronta'
      : status === 'idle'
      ? `Jarvis ${liveLabel}`
      : PHASE_LABEL[status];
  const isError = status === 'error';
  const isMini = hud.mode === 'mini' || canClickWake;

  // In toggle mode the send edge is a SECOND keypress — say so, or users
  // hold-release and think voice broke.
  const listeningHint =
    status === 'listening' && info
      ? info.hotkeyMode === 'hold'
        ? `solte ${info.shortcut} para enviar`
        : `pressione ${info.shortcut} de novo para enviar`
      : null;

  const beginDrag = (e: React.PointerEvent<HTMLElement>) => {
    const shell = shellRef.current;
    if (!shell || dragRef.current) return;
    const rect = shell.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const shell = shellRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !shell) return;
    if (
      Math.abs(e.clientX - drag.startX) > CLICK_SLOP_PX ||
      Math.abs(e.clientY - drag.startY) > CLICK_SLOP_PX
    ) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    const rect = shell.getBoundingClientRect();
    const left = Math.min(
      Math.max(e.clientX - drag.offsetX, -rect.width / 2),
      window.innerWidth - rect.width / 2,
    );
    const top = Math.min(
      Math.max(e.clientY - drag.offsetY, 0),
      window.innerHeight - 24,
    );
    setDragPos({ left, top });
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const shell = shellRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
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
    } else if (canClickWake) {
      requestJarvisWake();
    } else if (isMini) {
      setHudMode('expanded'); // clique (sem drag) na pill = expandir
    }
    setDragPos(null);
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
        className={`voice-hud voice-hud--mini voice-hud--${status} ${dragPos ? 'voice-hud--dragging' : ''}`}
        style={positionStyle}
        role="status"
        aria-live="polite"
        title={
          canClickWake
            ? 'JARVIS — clique para acordar, arraste para mover'
            : 'JARVIS — clique para expandir, arraste para mover'
        }
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {orb}
        <span className="voice-hud__mini-label">
          {wakeBlocked
            ? 'wake preso'
            : isError
              ? 'erro'
              : canClickWake
                ? 'pronta'
                : status === 'idle'
                ? liveLabel
                : PHASE_LABEL[status]}
        </span>
        <button
          className="voice-hud__ctl"
          title="Ocultar (só áudio)"
          aria-label="Ocultar HUD da JARVIS (modo só áudio)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setHudMode('hidden')}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={`voice-hud voice-hud--expanded voice-hud--${status} ${dragPos ? 'voice-hud--dragging' : ''}`}
      style={{ ...positionStyle, width: hud.width }}
      role="status"
      aria-live="polite"
    >
      <div
        className="voice-hud__titlebar"
        title="Arraste para mover — solte perto de um canto para ancorar"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="voice-hud__grip" aria-hidden="true">
          ▚▚
        </span>
        <span className="voice-hud__eyebrow">
          {info?.jarvisLive.enabled ? 'JARVIS LIVE' : 'JARVIS'}
        </span>
        <span className="voice-hud__ctls">
          <button
            className="voice-hud__ctl"
            title="Minimizar (pill)"
            aria-label="Minimizar HUD da JARVIS"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setHudMode('mini')}
          >
            ▁
          </button>
          <button
            className="voice-hud__ctl"
            title="Ocultar (só áudio)"
            aria-label="Ocultar HUD da JARVIS (modo só áudio)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setHudMode('hidden')}
          >
            ✕
          </button>
        </span>
      </div>
      <div className="voice-hud__shell">
        {orb}
        <div className="voice-hud__body">
          <span className="voice-hud__label">{label}</span>
          {isError && error ? (
            <span className="voice-hud__detail voice-hud__detail--error">{error}</span>
          ) : (
            <>
              {wakeBlocked && (
                <span className="voice-hud__detail voice-hud__detail--error">
                  Outra instância do NexusIDE está ouvindo "Hey Jarvis" (PID {wakeBlockedPid}).
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

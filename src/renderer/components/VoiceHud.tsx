import { useEffect, useRef } from 'react';
import { useVoiceStore, type VoiceUiStatus } from '../voice/voice-store';

/**
 * HUD flutuante que mostra a fase do pipeline de voz ao vivo (ouvindo →
 * transcrevendo → enviando → falando), o último transcript e qualquer erro.
 * No Jarvis Live fica visível enquanto pronto, para a assistente não sumir
 * entre turnos. O orb reage à amplitude REAL do mic (voice-store.level).
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

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function VoiceHud() {
  const status = useVoiceStore((s) => s.status);
  const transcript = useVoiceStore((s) => s.lastTranscript);
  const note = useVoiceStore((s) => s.note);
  const error = useVoiceStore((s) => s.error);
  const info = useVoiceStore((s) => s.info);
  const liveState = useVoiceStore((s) => s.liveState);
  const liveTool = useVoiceStore((s) => s.liveTool);

  const liveStatus = liveState?.status ?? 'dormant';
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

  if (status === 'idle' && !liveVisible) return null;

  const liveLabel = LIVE_LABEL[liveStatus] ?? liveStatus;
  const label = status === 'idle' ? `Jarvis ${liveLabel}` : PHASE_LABEL[status];
  const isError = status === 'error';

  // In toggle mode the send edge is a SECOND keypress — say so, or users
  // hold-release and think voice broke.
  const listeningHint =
    status === 'listening' && info
      ? info.hotkeyMode === 'hold'
        ? `solte ${info.shortcut} para enviar`
        : `pressione ${info.shortcut} de novo para enviar`
      : null;

  return (
    <div
      className={`voice-hud voice-hud--${status}`}
      role="status"
      aria-live="polite"
    >
      <div className="voice-hud__shell">
        <div className="voice-orb" aria-hidden="true" ref={orbRef}>
          <span className="voice-orb__ring voice-orb__ring--outer" />
          <span className="voice-orb__ring voice-orb__ring--middle" />
          <span className="voice-orb__ring voice-orb__ring--inner" />
          <span className="voice-orb__core" />
          <span className="voice-orb__scan voice-orb__scan--a" />
          <span className="voice-orb__scan voice-orb__scan--b" />
        </div>
        <div className="voice-hud__body">
          <span className="voice-hud__eyebrow">
            {info?.jarvisLive.enabled ? 'JARVIS LIVE' : 'JARVIS'}
          </span>
          <span className="voice-hud__label">{label}</span>
          {isError && error ? (
            <span className="voice-hud__detail voice-hud__detail--error">{error}</span>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

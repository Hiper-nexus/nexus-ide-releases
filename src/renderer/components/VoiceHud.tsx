import { useVoiceStore, type VoiceUiStatus } from '../voice/voice-store';

/**
 * Floating HUD that surfaces the live voice pipeline phase (listening →
 * transcribing → routing → speaking) plus the last transcript and any error.
 * Hidden while idle so it never occludes the workspace.
 */

const PHASE_LABEL: Record<Exclude<VoiceUiStatus, 'idle'>, string> = {
  listening: 'Listening',
  transcribing: 'Transcribing',
  routing: 'Sending to pane',
  speaking: 'Speaking',
  error: 'Voice error',
};

export function VoiceHud() {
  const status = useVoiceStore((s) => s.status);
  const transcript = useVoiceStore((s) => s.lastTranscript);
  const note = useVoiceStore((s) => s.note);
  const error = useVoiceStore((s) => s.error);

  if (status === 'idle') return null;

  const label = PHASE_LABEL[status];
  const isError = status === 'error';

  return (
    <div
      className={`voice-hud voice-hud--${status}`}
      role="status"
      aria-live="polite"
    >
      <div className="voice-hud__shell">
        <div className="voice-orb" aria-hidden="true">
          <span className="voice-orb__ring voice-orb__ring--outer" />
          <span className="voice-orb__ring voice-orb__ring--middle" />
          <span className="voice-orb__ring voice-orb__ring--inner" />
          <span className="voice-orb__core" />
          <span className="voice-orb__scan voice-orb__scan--a" />
          <span className="voice-orb__scan voice-orb__scan--b" />
        </div>
        <div className="voice-hud__body">
          <span className="voice-hud__eyebrow">JARVIS</span>
          <span className="voice-hud__label">{label}</span>
          {isError && error ? (
            <span className="voice-hud__detail voice-hud__detail--error">{error}</span>
          ) : (
            <>
              {transcript && <span className="voice-hud__detail">"{transcript}"</span>}
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

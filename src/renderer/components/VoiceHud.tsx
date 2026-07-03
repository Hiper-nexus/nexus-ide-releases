import { useVoiceStore, type VoiceUiStatus } from '../voice/voice-store';

/**
 * Floating HUD that surfaces the live voice pipeline phase (listening →
 * transcribing → routing → speaking) plus the last transcript and any error.
 * Hidden while idle so it never occludes the workspace.
 */

const PHASE_LABEL: Record<Exclude<VoiceUiStatus, 'idle'>, string> = {
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  routing: 'Routing to pane…',
  speaking: 'Speaking…',
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
      <span className={`voice-hud__pulse ${isError ? 'voice-hud__pulse--error' : ''}`} />
      <div className="voice-hud__body">
        <span className="voice-hud__label">{label}</span>
        {isError && error ? (
          <span className="voice-hud__detail voice-hud__detail--error">{error}</span>
        ) : (
          <>
            {transcript && <span className="voice-hud__detail">“{transcript}”</span>}
            {note && <span className="voice-hud__detail voice-hud__detail--note">↳ {note}</span>}
          </>
        )}
      </div>
    </div>
  );
}

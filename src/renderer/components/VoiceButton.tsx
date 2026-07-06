import { useVoiceStore } from '../voice/voice-store';

/**
 * WorkspaceBar voice control: a mic pill showing whether voice is armed, the
 * active STT/TTS providers, and the current phase. Click opens voice settings.
 */

function providerShort(provider: string | undefined): string {
  if (!provider) return '—';
  return provider.replace('macos-say', 'say').replace('local-whisper', 'whisper.cpp');
}

export function VoiceButton() {
  const info = useVoiceStore((s) => s.info);
  const status = useVoiceStore((s) => s.status);
  const liveState = useVoiceStore((s) => s.liveState);
  const openSettings = useVoiceStore((s) => s.openSettings);

  const stt = providerShort(info?.stt.active?.provider);
  const tts = providerShort(info?.tts.active?.provider);
  const armed = info?.enabled ?? false;
  const liveOn = info?.jarvisLive.enabled === true;
  const wakeBlockedPid = info?.wakeLockHolderPid ?? null;
  const wakeBlocked = info?.wakeWordEnabled === true && wakeBlockedPid !== null;
  const liveActive =
    liveOn &&
    liveState?.status !== undefined &&
    liveState.status !== 'off' &&
    liveState.status !== 'dormant';
  const active = (status !== 'idle' && status !== 'error') || liveActive;
  const label =
    wakeBlocked
      ? 'wake preso'
      : liveOn && liveState?.status && liveState.status !== 'off'
      ? `live:${liveState.status}`
      : active
        ? status
        : `${stt} → ${tts}`;

  return (
    <button
      className={`workspace-bar__btn workspace-bar__btn--voice ${active ? 'workspace-bar__btn--voice-active' : ''}`}
      onClick={openSettings}
      title={
        info
          ? `Push-to-talk: ${info.shortcut} (${info.hotkeyMode}) · STT ${stt} · TTS ${tts}${liveOn ? ' · Jarvis Live' : ''}${wakeBlocked ? ` · wake preso pelo PID ${wakeBlockedPid}` : ''}`
          : 'Voice pipeline'
      }
    >
      <span className={`voice-dot ${armed ? 'voice-dot--on' : ''} ${active ? 'voice-dot--pulse' : ''}`} />
      <span className="workspace-bar__voice-label">
        {label}
      </span>
    </button>
  );
}

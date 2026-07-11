import { useVoiceStore } from '../voice/voice-store';
import { requestJarvisWake } from '../voice/manual-wake';

/**
 * WorkspaceBar voice control: a mic pill showing whether voice is armed, the
 * active STT/TTS providers, and the current phase. Click wakes Jarvis; modified
 * click/right-click opens voice settings.
 */

function providerShort(provider: string | undefined): string {
  if (!provider) return '—';
  return provider.replace('macos-say', 'say').replace('local-whisper', 'whisper.cpp');
}

export function VoiceButton() {
  const info = useVoiceStore((s) => s.info);
  const status = useVoiceStore((s) => s.status);
  const liveState = useVoiceStore((s) => s.liveState);
  const responseMuted = useVoiceStore((s) => s.responseMuted);
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
      : responseMuted
        ? 'muda'
      : liveOn && liveState?.status && liveState.status !== 'off'
      ? `live:${liveState.status}`
      : active
        ? status
        : `${stt} → ${tts}`;

  function handleClick(e: React.MouseEvent<HTMLButtonElement>): void {
    if (e.altKey || e.metaKey || e.ctrlKey) {
      openSettings();
      return;
    }
    requestJarvisWake();
  }

  function handleContextMenu(e: React.MouseEvent<HTMLButtonElement>): void {
    e.preventDefault();
    openSettings();
  }

  return (
    <button
      className={`workspace-bar__btn workspace-bar__btn--voice ${active ? 'workspace-bar__btn--voice-active' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={
        info
          ? `Clique para acordar a Jarvis · ⌥/⌘ clique para ajustes · Push-to-talk: ${info.shortcut} (${info.hotkeyMode}) · STT ${stt} · TTS ${tts}${liveOn ? ' · Jarvis Live' : ''}${responseMuted ? ' · respostas mudas' : ''}${wakeBlocked ? ` · wake preso pelo PID ${wakeBlockedPid}` : ''}`
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

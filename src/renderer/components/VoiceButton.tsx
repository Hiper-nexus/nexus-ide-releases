import { useVoiceStore } from '../voice/voice-store';
import { requestJarvisWake } from '../voice/manual-wake';
import { isMac } from '../lib/platform';

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
  const setHudMode = useVoiceStore((s) => s.setHudMode);

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

  /** Labels curtos e legíveis — evita LIVE:DORMANT técnico na barra. */
  const liveStatusLabel = (s: string): string => {
    switch (s) {
      case 'listening':
        return 'ouvindo';
      case 'thinking':
        return 'pensando';
      case 'speaking':
        return 'falando';
      case 'interrupted':
        return 'interrompida';
      case 'dormant':
        return 'pronta';
      case 'error':
        return 'erro';
      case 'connecting':
        return 'conectando';
      default:
        return s;
    }
  };
  const classicStatusLabel = (s: string): string => {
    switch (s) {
      case 'listening':
        return 'ouvindo';
      case 'transcribing':
        return 'transcrevendo';
      case 'routing':
        return 'processando';
      case 'speaking':
        return 'falando';
      case 'error':
        return 'erro';
      default:
        return s;
    }
  };

  const label =
    wakeBlocked
      ? 'wake ocupado'
      : responseMuted
        ? 'muda'
      : liveOn && liveState?.status && liveState.status !== 'off'
      ? `Jarvis · ${liveStatusLabel(liveState.status)}`
      : active
        ? `Jarvis · ${classicStatusLabel(status)}`
        : liveOn
          ? 'Jarvis'
          : `${stt} → ${tts}`;

  function handleClick(e: React.MouseEvent<HTMLButtonElement>): void {
    if (e.altKey || e.metaKey || e.ctrlKey) {
      openSettings();
      return;
    }
    // “MUDA” is a state that needs an explicit recovery surface. Opening the
    // expanded HUD exposes the unmute control instead of silently starting a
    // voice turn that the user still cannot hear.
    if (responseMuted) {
      setHudMode('expanded');
      return;
    }
    if (wakeBlocked) {
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
          ? `${responseMuted ? 'Clique para abrir os controles e ativar o áudio' : wakeBlocked ? 'Clique para abrir o diagnóstico de voz' : 'Clique para acordar a Jarvis'} · ${isMac() ? '⌥/⌘' : 'Alt/Ctrl'} clique para ajustes · Push-to-talk: ${info.shortcut} (${info.hotkeyMode}) · STT ${stt} · TTS ${tts}${liveOn ? ' · Jarvis Live' : ''}${responseMuted ? ' · respostas mudas' : ''}${wakeBlocked ? ` · wake ocupado pelo PID ${wakeBlockedPid}` : ''}`
          : 'Pipeline de voz'
      }
    >
      <span className={`voice-dot ${armed ? 'voice-dot--on' : ''} ${active ? 'voice-dot--pulse' : ''}`} />
      <span className="workspace-bar__voice-label">
        {label}
      </span>
    </button>
  );
}

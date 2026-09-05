import { useEffect, useMemo, useState } from 'react';
import type { ScreenPermissionStatus } from '../../../shared/vision-ipc';
import { useCostStore } from '../../state/cost-store';
import { useUsageStore } from '../../state/usage-store';
import { useVoiceStore } from '../../voice/voice-store';
import {
  type AudioDeviceInfo,
  type MicPermissionStatus,
  formatAge,
  formatUsd,
  MetricTile,
  permissionLabel,
  permissionTone,
  readAudioDevices,
  readMicPermission,
} from './ops-format';
import { DoctorEngineSettings } from './DoctorEngineSettings';
import { ContextDraftsSection } from './ContextDraftsSection';
import { TerminalPerformanceStatus } from './TerminalPerformanceStatus';
import { SettingsSectionTitle } from './SettingsSectionTitle';

function useDiagnosticsSnapshot() {
  const [micPermission, setMicPermission] =
    useState<MicPermissionStatus>('unavailable');
  const [screenPermission, setScreenPermission] =
    useState<ScreenPermissionStatus | 'error'>('not-determined');
  const [devices, setDevices] = useState<AudioDeviceInfo>({
    count: 0,
    activeLabel: null,
    error: null,
  });

  const refresh = async () => {
    const [mic, audio] = await Promise.all([
      readMicPermission(),
      readAudioDevices(),
    ]);
    setMicPermission(mic);
    setDevices(audio);
    try {
      setScreenPermission(await window.nexus.vision.checkPermission());
    } catch {
      setScreenPermission('error');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return { micPermission, screenPermission, devices, refresh };
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function formatMs(value: number | null): string {
  return value === null ? 'sem amostras' : `${Math.round(value)}ms`;
}

function micHealthLabel(value: string): string {
  return (
    {
      healthy: 'saudável',
      needsPermission: 'permissão pendente',
      phantomGrant: 'permissão inconsistente',
      silent: 'sem sinal',
      unavailable: 'indisponível',
    }[value] ?? value
  );
}

function liveStatusLabel(value: string | undefined): string {
  if (!value || value === 'off') return 'desligado';
  return (
    {
      dormant: 'em espera',
      listening: 'ouvindo',
      thinking: 'processando',
      speaking: 'falando',
      interrupted: 'interrompido',
      connecting: 'conectando',
      error: 'erro',
    }[value] ?? value
  );
}

export function DiagnosticsSection() {
  const info = useVoiceStore((s) => s.info);
  const level = useVoiceStore((s) => s.level);
  const micHealth = useVoiceStore((s) => s.micHealth);
  const liveState = useVoiceStore((s) => s.liveState);
  const liveTool = useVoiceStore((s) => s.liveTool);
  const liveTranscript = useVoiceStore((s) => s.liveTranscript);
  const cost = useCostStore((s) => s.snapshot);
  const usage = useUsageStore((s) => s.snapshot);
  const { micPermission, screenPermission, devices, refresh } =
    useDiagnosticsSnapshot();
  const [legalNote, setLegalNote] = useState<string | null>(null);

  const wakeState = useMemo(() => {
    if (!info?.wakeWordEnabled) return { value: 'desligado', tone: 'warn' };
    if (info.wakeLockHolderPid) {
      return { value: `bloqueado por PID ${info.wakeLockHolderPid}`, tone: 'danger' };
    }
    if (!info.hasWakeKey) return { value: 'sem chave wake', tone: 'warn' };
    if (micHealth === 'needsPermission') {
      return { value: 'sem permissão de mic', tone: 'danger' };
    }
    if (micHealth === 'silent') return { value: 'stream silencioso', tone: 'warn' };
    return { value: 'armado', tone: 'ok' };
  }, [info, micHealth]);

  const latestTranscript = liveTranscript.at(-1);
  const inputLevel = `${Math.round(level * 100)}%`;
  const latencyTimes = liveTranscript
    .map((event) => event.at)
    .concat(liveTool ? [liveTool.at] : [])
    .sort((a, b) => a - b);
  const latencyDeltas = latencyTimes
    .slice(1)
    .map((at, index) => at - latencyTimes[index])
    .filter((delta) => delta > 0 && delta < 5 * 60_000);

  return (
    <section>
      <SettingsSectionTitle>Diagnóstico</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Confira microfone, permissões e funcionamento da assistente.
        Esta página não ativa o microfone.
      </p>

      <DoctorEngineSettings />

      <ContextDraftsSection />

      <h4 className="release-section-title">Interface e terminais</h4>
      <TerminalPerformanceStatus />

      <div className="ops-metric-grid">
        <MetricTile
          label="Permissão do mic"
          value={permissionLabel(micPermission)}
          tone={permissionTone(micPermission)}
          detail={devices.error ?? `${devices.count} entrada(s) detectada(s)`}
        />
        <MetricTile
          label="Microfone selecionado"
          value={devices.activeLabel ?? (devices.count > 0 ? 'sem rótulo' : 'não detectado')}
          tone={devices.count > 0 ? 'ok' : 'warn'}
          detail="macOS só libera nomes após consentimento de microfone."
        />
        <MetricTile
          label="Nível do microfone"
          value={inputLevel}
          tone={level > 0.05 ? 'ok' : 'warn'}
          detail={`Saúde: ${micHealthLabel(micHealth)}`}
        />
        <MetricTile
          label="Gravação de tela"
          value={permissionLabel(screenPermission)}
          tone={permissionTone(screenPermission)}
          detail="Necessário para Vision capturar a janela Nexus."
        />
        <MetricTile
          label="Ativação por voz"
          value={wakeState.value}
          tone={wakeState.tone}
          detail={info?.wakeWordEnabled ? 'Hey Jarvis habilitado.' : 'Wake word desligada.'}
        />
        <MetricTile
          label="Sessão em tempo real"
          value={liveStatusLabel(liveState?.status)}
          tone={liveState?.realtimeReady ? 'ok' : 'warn'}
          detail={liveState ? `${liveState.turns} turno(s), ativo ${formatAge(liveState.lastActiveAt)}` : 'Sem conversa contínua ativa.'}
        />
        <MetricTile
          label="Tokens reais"
          value={`${usage.global.inputTokens + usage.global.outputTokens}`}
          detail={`${usage.global.turns} turno(s), ${formatUsd(usage.global.costUsd)}`}
        />
        <MetricTile
          label="Latência p50"
          value={formatMs(percentile(latencyDeltas, 0.5))}
          detail="Tempo entre eventos recentes."
        />
        <MetricTile
          label="Latência p95"
          value={formatMs(percentile(latencyDeltas, 0.95))}
          detail={`${latencyDeltas.length} amostra(s) em memória.`}
        />
        <MetricTile
          label="Custo heurístico"
          value={formatUsd(cost.totalUsd)}
          detail={`${formatUsd(cost.perMinuteUsd)}/min, ${cost.tokPerSec.toFixed(1)} tok/s`}
        />
      </div>

      <div className="ops-log-strip">
        <div>
          <span className="ops-log-strip__label">Última transcrição</span>
          <p>{latestTranscript?.text || 'Nenhuma transcrição recente.'}</p>
        </div>
        <div>
          <span className="ops-log-strip__label">Última ferramenta</span>
          <p>{liveTool?.summary || 'Nenhuma ferramenta usada nesta sessão.'}</p>
        </div>
      </div>

      <div className="settings-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button
          className="settings-btn"
          type="button"
          title="Abre THIRD_PARTY_NOTICES.md (MIT Orca, fontes, Onlook…) no visualizador do SO"
          onClick={() => {
            void window.nexus.app.openLegalNotices().then((r) => {
              setLegalNote(
                r.ok
                  ? 'Notices abertas no app do sistema'
                  : r.error ?? 'Não foi possível abrir as notices',
              );
            });
          }}
        >
          Licenças de terceiros
        </button>
        {legalNote && (
          <span className="settings-detail__hint" style={{ margin: 0 }}>
            {legalNote}
          </span>
        )}
        <button className="settings-btn" type="button" onClick={() => void refresh()}>
          Atualizar diagnóstico
        </button>
        <button className="settings-btn" type="button" onClick={() => window.nexus.voice.openMicSettings()}>
          Abrir privacidade do mic
        </button>
        <button className="settings-btn" type="button" onClick={() => window.nexus.voice.openSoundSettings()}>
          Abrir som
        </button>
      </div>
    </section>
  );
}

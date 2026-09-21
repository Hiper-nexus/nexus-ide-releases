import { useEffect, useState } from 'react';
import type { ScreenPermissionStatus } from '../../../shared/vision-ipc';
import { useVisionConsentStore } from '../../state/vision-consent-store';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import {
  formatDate,
  MetricTile,
  permissionLabel,
  permissionTone,
  StatusPill,
} from './ops-format';

function VisionConsentPanel({
  active,
  pending,
  onToggle,
}: {
  active: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="ops-consent-panel">
      <div>
        <p className="ops-consent-panel__title">
          Permitir envio de imagem da tela para nuvem
        </p>
        <p className="ops-consent-panel__copy">
          Permite que a IA analise imagens da janela do Nexus nesta sessão.
          Ao desativar, o envio é bloqueado e a imagem temporária é apagada.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label="Permitir envio de imagem da tela para nuvem"
        className={`ops-switch ${active ? 'ops-switch--on' : ''}`}
        disabled={pending}
        onClick={onToggle}
      >
        <span className="ops-switch__track">
          <span className="ops-switch__thumb" />
        </span>
        <span className="ops-switch__label">
          {pending ? 'salvando' : active ? 'permitido' : 'bloqueado'}
        </span>
      </button>
    </div>
  );
}

/**
 * Erros de ipcRenderer.invoke chegam embrulhados ("Error invoking remote
 * method 'vision:capture': ScreenRecordingPermissionDenied: …") — exibe só a
 * mensagem humana, sem o prefixo do transporte nem o nome da classe.
 */
function friendlyCaptureError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^ScreenRecordingPermissionDenied:\s*/, '');
}

export function VisionSection() {
  const allowCloudImage = useVisionConsentStore((s) => s.allowCloudImage);
  const consentToken = useVisionConsentStore((s) => s.consentToken);
  const pending = useVisionConsentStore((s) => s.pending);
  const error = useVisionConsentStore((s) => s.error);
  const lastCapture = useVisionConsentStore((s) => s.lastCapture);
  const enableCloudImage = useVisionConsentStore((s) => s.enableCloudImage);
  const disableCloudImage = useVisionConsentStore((s) => s.disableCloudImage);
  const [permission, setPermission] =
    useState<ScreenPermissionStatus | 'error'>('not-determined');
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);

  const refreshPermission = async () => {
    try {
      setPermission(await window.nexus.vision.checkPermission());
    } catch {
      setPermission('error');
    }
  };

  const toggleConsent = async () => {
    if (allowCloudImage) await disableCloudImage();
    else await enableCloudImage();
  };

  const captureMetadata = async () => {
    setCaptureStatus('capturando');
    try {
      const result = await window.nexus.vision.capture();
      useVisionConsentStore.getState().markCaptured(result);
      setCaptureStatus(`${result.width}x${result.height} capturado`);
      void refreshPermission();
    } catch (err) {
      setCaptureStatus(friendlyCaptureError(err));
      void refreshPermission();
    }
  };

  const openScreenSettings = async () => {
    const res = await window.nexus.vision.openScreenSettings();
    if (!res.ok && res.error) setCaptureStatus(res.error);
  };

  /**
   * Passo 1 do fluxo guiado: registra o Nexus no TCC (o macOS só LISTA o app
   * no painel de Gravação de Tela após a primeira tentativa de captura) e
   * abre o prompt nativo. Depois disso, nos Ajustes é só virar a chave —
   * sem "+", sem buscar pasta.
   */
  const requestScreenPermission = async () => {
    setCaptureStatus('registrando o Nexus no macOS…');
    try {
      const status = await window.nexus.vision.requestPermission();
      setPermission(status);
      setCaptureStatus(
        status === 'granted'
          ? 'permissão concedida — capture à vontade'
          : 'Nexus registrado: nos Ajustes, vire a chave do NexusIDE e reabra o app',
      );
    } catch (err) {
      setCaptureStatus(friendlyCaptureError(err));
    }
  };

  useEffect(() => {
    void refreshPermission();
  }, []);

  return (
    <section className="sys-section">
      <div className="settings-detail__split-head">
        <div>
          <SettingsSectionTitle>Captura de tela</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Escolha se a IA pode receber imagens da janela do Nexus.
            A captura local permanece limitada a essa janela.
          </p>
        </div>
        <StatusPill tone={allowCloudImage ? 'ok' : 'warn'}>
          {allowCloudImage ? 'Envio permitido' : 'Somente local'}
        </StatusPill>
      </div>

      <VisionConsentPanel
        active={allowCloudImage}
        pending={pending}
        onToggle={() => void toggleConsent()}
      />
      {error && <p className="settings-error" role="alert">{error}</p>}

      <div className="sys-subhead">
        <h4 className="sys-subhead__title">Estado</h4>
      </div>
      <div className="ops-metric-grid">
        <MetricTile
          label="Permissão de captura"
          value={permissionLabel(permission)}
          tone={permissionTone(permission)}
          detail="Acesso do sistema à captura da janela Nexus."
        />
        <MetricTile
          label="Autorização da sessão"
          value={consentToken ? 'Ativa' : 'Inativa'}
          tone={consentToken ? 'ok' : 'warn'}
          detail={consentToken ? 'Válido só até desativar ou reiniciar.' : 'Envio de imagens bloqueado.'}
        />
        <MetricTile
          label="Última captura"
          value={lastCapture ? `${lastCapture.width}x${lastCapture.height}` : 'nenhuma'}
          detail={lastCapture ? formatDate(lastCapture.capturedAt) : 'Use captura sob demanda para testar.'}
        />
      </div>

      <div className="sys-actions">
        {permission !== 'granted' && window.nexus.platform === 'darwin' && (
          <button
            className="settings-btn settings-btn--primary"
            type="button"
            onClick={() => void requestScreenPermission()}
          >
            Pedir permissão ao macOS
          </button>
        )}
        <button className="settings-btn" type="button" onClick={() => void captureMetadata()}>
          Testar captura local
        </button>
        <button className="settings-btn" type="button" onClick={() => void refreshPermission()}>
          Verificar permissão
        </button>
        {permission === 'denied' && window.nexus.platform === 'darwin' && (
          <button className="settings-btn" type="button" onClick={() => void openScreenSettings()}>
            Abrir Ajustes do Sistema
          </button>
        )}
      </div>
      {permission !== 'granted' && window.nexus.platform === 'darwin' && (
        <ol className="vision-steps">
          <li>Peça permissão ao macOS — o sistema registra o NexusIDE.</li>
          <li>Nos Ajustes do Sistema, ative o NexusIDE em Gravação de Tela.</li>
          <li>Reabra o app para a captura funcionar.</li>
        </ol>
      )}
      {captureStatus && (
        <p className="settings-field__note" role="status">{captureStatus}</p>
      )}
    </section>
  );
}

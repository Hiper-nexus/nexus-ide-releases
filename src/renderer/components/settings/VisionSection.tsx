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
          Quando ativo, o main libera a última captura bruta da janela Nexus
          somente com token de consentimento. Ao desativar, o token é invalidado
          e a captura bruta em memória é descartada.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={active}
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
    <section>
      <div className="settings-detail__split-head">
        <div>
          <SettingsSectionTitle>Vision</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Jarvis só envia imagem da janela Nexus para provedores multimodais
            quando você permite nesta sessão. Capturas locais e OCR continuam
            limitados à janela do Nexus.
          </p>
        </div>
        <StatusPill tone={allowCloudImage ? 'ok' : 'warn'}>
          {allowCloudImage ? 'consent ativo' : 'local only'}
        </StatusPill>
      </div>

      <VisionConsentPanel
        active={allowCloudImage}
        pending={pending}
        onToggle={() => void toggleConsent()}
      />
      {error && <p className="settings-error">{error}</p>}

      <div className="ops-metric-grid">
        <MetricTile
          label="Screen Recording"
          value={permissionLabel(permission)}
          tone={permissionTone(permission)}
          detail="Permissão macOS para capturar a janela Nexus."
        />
        <MetricTile
          label="Token de consent"
          value={consentToken ? 'emitido' : 'inativo'}
          tone={consentToken ? 'ok' : 'warn'}
          detail={consentToken ? 'Válido só até desativar ou reiniciar.' : 'Imagem bruta não sai do main.'}
        />
        <MetricTile
          label="Última captura"
          value={lastCapture ? `${lastCapture.width}x${lastCapture.height}` : 'nenhuma'}
          detail={lastCapture ? formatDate(lastCapture.capturedAt) : 'Use captura sob demanda para testar.'}
        />
      </div>

      <div className="settings-row">
        <button className="settings-btn" type="button" onClick={() => void captureMetadata()}>
          Testar captura local
        </button>
        <button className="settings-btn" type="button" onClick={() => void refreshPermission()}>
          Rechecar permissão
        </button>
        {permission !== 'granted' && window.nexus.platform === 'darwin' && (
          <button
            className="settings-btn settings-btn--primary"
            type="button"
            onClick={() => void requestScreenPermission()}
          >
            Pedir permissão ao macOS
          </button>
        )}
        {permission === 'denied' && window.nexus.platform === 'darwin' && (
          <button className="settings-btn" type="button" onClick={() => void openScreenSettings()}>
            Abrir Ajustes do Sistema
          </button>
        )}
      </div>
      {permission !== 'granted' && window.nexus.platform === 'darwin' && (
        <p className="settings-field__note">
          Fluxo: 1) “Pedir permissão ao macOS” registra o NexusIDE na lista de
          Gravação de Tela (sem “+” nem buscar pasta); 2) nos Ajustes, vire a
          chave do NexusIDE; 3) feche e reabra o app — o macOS só aplica a
          permissão no próximo start.
        </p>
      )}
      {captureStatus && <p className="settings-field__note">{captureStatus}</p>}
    </section>
  );
}

import { useState } from 'react';
import type { RedlineInstallStatus } from '../../../shared/redline-types';
import { useToastStore } from '../../state/toast-store';

/**
 * Linha do Nexus Redline no Linux (Uso e cotas). Diferente do macOS e do
 * Windows, não há companheiro para instalar: o Redline é uma bandeja DENTRO do
 * NexusIDE. "Mostrar" liga e lembra a escolha; "Ocultar" desliga. A linha diz
 * sem rodeio que o ícone só existe enquanto o app estiver aberto.
 */

const GUIDANCE =
  'Se o ícone não aparecer: no Omarchy ele fica na gaveta da seta < da barra; no GNOME falta a extensão AppIndicator; no Waybar/Hyprland, o módulo tray precisa estar ligado.';

type TrayAction = 'install' | 'hide';

interface Props {
  status: RedlineInstallStatus;
  onChange: (status: RedlineInstallStatus) => void;
}

function headline(tray: NonNullable<RedlineInstallStatus['inAppTray']>): string {
  if (tray.state === 'running') {
    return 'Nexus Redline está na bandeja do sistema mostrando as cotas, enquanto o NexusIDE estiver aberto. Clique no ícone para abrir as cotas aqui; o botão direito mostra a lista.';
  }
  if (tray.state === 'unavailable') {
    return `${tray.reason ?? 'O ícone não apareceu na bandeja.'} Sua área de trabalho precisa expor uma bandeja do tipo StatusNotifier/AppIndicator.`;
  }
  return 'Mostra a folga de cada conta na bandeja do sistema. No Linux o Redline vive dentro do NexusIDE: o ícone fica na bandeja enquanto o app estiver aberto.';
}

export function RedlineLinuxTrayRow({ status, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const pushToast = useToastStore((state) => state.push);
  const tray = status.inAppTray;
  if (!tray) return null;

  async function run(action: TrayAction): Promise<void> {
    setBusy(true);
    try {
      const result = await window.nexus.redline[action]();
      pushToast(result.ok ? 'success' : 'warn', 'Nexus Redline', result.message);
      onChange(await window.nexus.redline.status());
    } catch (error) {
      pushToast('warn', 'Nexus Redline', String((error as Error).message ?? error));
    } finally {
      setBusy(false);
    }
  }

  const unavailable = tray.state === 'unavailable';
  const running = tray.state === 'running';

  return (
    <div className="quota-panel__redline">
      <div>
        <strong>Bandeja do sistema</strong>
        <p className="settings-detail__hint">{headline(tray)}</p>
        {!unavailable && <p className="settings-detail__hint">{GUIDANCE}</p>}
      </div>
      <div className="quota-panel__redline-actions">
        {running ? (
          <button
            type="button"
            className="settings-btn"
            disabled={busy}
            onClick={() => void run('hide')}
          >
            {busy ? 'Aguarde…' : 'Ocultar da bandeja'}
          </button>
        ) : (
          <button
            type="button"
            className="settings-btn"
            disabled={busy}
            onClick={() => void run('install')}
          >
            {busy ? 'Aguarde…' : unavailable ? 'Tentar de novo' : 'Mostrar na bandeja'}
          </button>
        )}
        {unavailable && (
          <button
            type="button"
            className="settings-btn"
            disabled={busy}
            onClick={() => void run('hide')}
          >
            Desligar
          </button>
        )}
      </div>
    </div>
  );
}

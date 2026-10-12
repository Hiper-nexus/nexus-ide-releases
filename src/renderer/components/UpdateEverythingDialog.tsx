import { useMemo, useState } from 'react';
import {
  planUpdateEverything,
  runUpdateEverything,
  updateEverythingLines,
  type UpdateEverythingProvider,
} from '../../shared/update-everything.logic';
import { useProviderStore } from '../state/provider-store';
import { OverlayLayer } from '../overlay/overlay-layer';
import { CloseButton } from './CloseButton';

function logUpdate(message: string, detail?: unknown): void {
  if (detail !== undefined) console.info(`[update-everything] ${message}`, detail);
  else console.info(`[update-everything] ${message}`);
}

function logErr(message: string, err: unknown): void {
  console.warn(`[update-everything] ${message}`, err);
}

/**
 * "Atualizar tudo" (herdado do t3code): providers CLIs + este app numa
 * passada só. Providers primeiro, install do app por último — o
 * relançamento encerra a corrida. O download do app roda em paralelo.
 */

type Props = {
  /** UpdateState do app (UpdateModal / useUpdateState). */
  localVersion: string | null;
  canDownloadLocal: boolean;
  canInstallLocal: boolean;
  downloadLocal?: () => Promise<boolean>;
  installLocal?: () => Promise<void>;
  onClose: () => void;
};

export function UpdateEverythingDialog({
  localVersion,
  canDownloadLocal,
  canInstallLocal,
  downloadLocal,
  installLocal,
  onClose,
}: Props) {
  const providers = useProviderStore((s) => s.providers);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const plan = useMemo(() => {
    // `canAutoInstall` é receita de INSTALAÇÃO — o update pode recusar
    // (`selectCliUpdateRecipe`). O plano lista o que a passada TENTA;
    // quem não tem receita de update sai com aviso, não com "falha".
    const updatable: UpdateEverythingProvider[] = providers
      .filter((p) => p.kind === 'cli-pty' && p.installed && p.canAutoInstall)
      .map((p) => ({
        adapterId: p.adapterId,
        label: p.label,
        canUpdate: true,
      }));
    return planUpdateEverything({
      localVersion: canInstallLocal ? localVersion : null,
      providers: updatable,
    });
  }, [providers, localVersion, canInstallLocal]);

  const lines = updateEverythingLines(plan);

  const start = () => {
    if (running || !plan.hasWork) return;
    setRunning(true);
    setFailed(null);
    logUpdate('update-everything:start', { summary: plan.summary });
    void runUpdateEverything({
      downloadLocal: canDownloadLocal ? downloadLocal : undefined,
      updateProviders: async () => {
        for (const p of plan.providers) {
          try {
            const result = await window.nexus.providers.installCli(
              p.adapterId,
              'update',
            );
            if (result && result.ok === false) {
              const err = result.error ?? '';
              // Sem receita de update ≠ falha da passada: some do "tudo",
              // avisa uma vez e segue para a próxima CLI.
              if (/receita|reconheci|não reconhe/i.test(err)) {
                setFailed(null);
                logUpdate('skip:sem-receita', { adapterId: p.adapterId, err });
              } else {
                setFailed(
                  `falha ao atualizar ${p.label}` + (err ? `: ${err}` : ''),
                );
              }
            }
          } catch (err) {
            logErr('update-everything:provider failed', err);
            setFailed(`falha ao atualizar ${p.label}`);
          }
        }
      },
      installLocal: canInstallLocal ? installLocal : undefined,
    })
      .then(() => {
        setDone(true);
        logUpdate('update-everything:done', { summary: plan.summary });
      })
      .catch((err) => {
        logErr('update-everything:run failed', err);
        setFailed(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setRunning(false));
  };

  return (
    <OverlayLayer>
      <div
        className="update-modal__backdrop overlay-scrim-glass overlay-scrim-enter"
        onClick={onClose}
      >
        <div
          className="update-modal overlay-enter"
          role="dialog"
          aria-modal="true"
          aria-label="Atualizar tudo"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="update-modal__head">
            <span className="update-modal__eyebrow">ATUALIZAR TUDO</span>
            <CloseButton onClick={onClose} label="Fechar" />
          </div>

          <p className="update-modal__phase">
            {plan.hasWork
              ? `Uma passada atualiza: ${plan.summary}.`
              : 'Nada para atualizar agora.'}
          </p>

          {lines.length > 0 && (
            <ul className="update-modal__notes" style={{ margin: 0, paddingLeft: '1.2em' }}>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          <p className="update-modal__hint">
            As CLIs são atualizadas primeiro. O app é instalado por último —
            o relançamento encerra a passada.
          </p>

          {failed && <p className="update-modal__error">{failed}</p>}
          {done && !failed && (
            <p className="update-modal__phase update-modal__phase--uptodate">
              Passada concluída.
            </p>
          )}

          <div className="update-modal__actions">
            <button
              type="button"
              className="update-modal__btn"
              onClick={onClose}
              disabled={running}
            >
              Fechar
            </button>
            <button
              type="button"
              className="update-modal__btn update-modal__btn--primary"
              onClick={start}
              disabled={running || !plan.hasWork}
            >
              {running ? 'Atualizando…' : 'Atualizar tudo'}
            </button>
          </div>
        </div>
      </div>
    </OverlayLayer>
  );
}

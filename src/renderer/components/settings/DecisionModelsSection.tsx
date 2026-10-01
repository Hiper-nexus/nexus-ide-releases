import { DecisionModeControls } from './DecisionModeControls';
import { ClefCredentials } from './ClefCredentials';
import { useDecisionModelSettings } from './use-decision-model-settings';
import type { DecisionSettings } from '../../../shared/decision-models';

export function DecisionModelsSection({ showCredentials = true }: { showCredentials?: boolean }) {
  const { status, supported, busy, error, notice, run, setError } = useDecisionModelSettings();
  function change(patch: Partial<DecisionSettings>) {
    if (!status) return;
    void run(async () => {
      await window.nexus.settings.orchSet({ decisionModels: { ...status.settings, ...patch } });
    }, 'Preferência de modelo salva.');
  }
  return <section className="settings-section decision-models" aria-label="Modelos de decisão" aria-busy={busy}>
    <header className="decision-models__head"><h3 className="settings-section-heading">Modelos de decisão</h3>
      <p className="settings-detail__hint">Jev e Clef se complementam. Escolha um provedor ou deixe o Nexus selecionar por tarefa.</p>
    </header>
    {!supported && <p className="settings-field__note">Para configurar Clef, atualize o Nexus.</p>}
    {supported && !status && !error && <div className="decision-models__loading" role="status">Carregando configuração…</div>}
    {status && <>
      <DecisionModeControls settings={status.settings} busy={busy} onChange={change} />
      {showCredentials ? <ClefCredentials status={status} busy={busy} run={run} onError={setError} />
        : <p className="settings-field__note">Configure Account ID e API Token Cloudflare em Chaves de API.</p>}
    </>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-field__note" role="status">{notice}</p>}
  </section>;
}

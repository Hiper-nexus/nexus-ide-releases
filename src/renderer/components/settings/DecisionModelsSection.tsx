import { DecisionModeControls } from './DecisionModeControls';
import { ClefCredentials } from './ClefCredentials';
import { decisionNotices } from './decision-readiness';
import { useDecisionModelSettings } from './use-decision-model-settings';
import type { DecisionSettings } from '../../../shared/decision-models';

const ERROR_ID = 'decision-models-error';

export function DecisionModelsSection({ showCredentials = true }: { showCredentials?: boolean }) {
  const { status, supported, busy, error, notice, run, setError } = useDecisionModelSettings();
  function change(patch: Partial<DecisionSettings>) {
    if (!status) return;
    void run(async () => {
      await window.nexus.settings.orchSet({ decisionModels: { ...status.settings, ...patch } });
    }, 'Preferência de modelo salva.');
  }
  const notices = status ? decisionNotices(status) : [];
  return <section className="settings-section decision-models" aria-label="Modelos de decisão" aria-busy={busy}>
    <header className="decision-models__head"><h3 className="settings-section-heading">Modelos de decisão</h3>
      <p className="settings-detail__hint">Jev, Clef e Luna (beta) se complementam. Escolha um provedor ou deixe o Nexus selecionar por tarefa.</p>
    </header>
    {!supported && <p className="settings-field__note">Para configurar Clef, atualize o Nexus.</p>}
    {supported && !status && !error && <div className="decision-models__loading" role="status">Carregando configuração…</div>}
    {status && <>
      {notices.length > 0 && <ul className="decision-models__notices" aria-label="Avisos dos modelos de decisão">
        {notices.map(entry => <li key={entry.id} className={`decision-models__notice decision-models__notice--${entry.tone}`}>{entry.text}</li>)}
      </ul>}
      <DecisionModeControls settings={status.settings} busy={busy} onChange={change} />
      {status.settings.mode === 'luna' && <div className="settings-row decision-models__actions">
        <button className="settings-btn settings-btn--sm" type="button" disabled={busy || !status.lunaReady} onClick={() => void run(async () => {
          const result = await window.nexus.decisionModels.test({ provider: 'luna' });
          if (!result.ok) throw new Error(result.detail);
        }, 'Conexão com a Luna confirmada.')}>Testar a Luna</button>
      </div>}
      {status.settings.mode === 'luna' && <p className="settings-field__note">A chave é a da OpenAI, em Chaves de API. O teste faz uma consulta pequena na Decisions API (beta).</p>}
      {showCredentials ? <ClefCredentials status={status} busy={busy} run={run} onError={setError} errorId={error ? ERROR_ID : undefined} />
        : <p className="settings-field__note">Configure Account ID e API Token Cloudflare em Chaves de API.</p>}
    </>}
    {error && <p id={ERROR_ID} className="settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-field__note" role="status">{notice}</p>}
  </section>;
}

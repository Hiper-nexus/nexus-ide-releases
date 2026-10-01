import type { DecisionSettings } from '../../../shared/decision-models';

export function DecisionModeControls({ settings, busy, onChange }: {
  settings: DecisionSettings; busy: boolean; onChange: (patch: Partial<DecisionSettings>) => void;
}) {
  return <>
    <div className="settings-form-grid">
      <label className="settings-field">Escolha do modelo
        <select className="settings-input" aria-label="Modo de decisão" value={settings.mode} disabled={busy}
          onChange={event => onChange({ mode: event.target.value as DecisionSettings['mode'] })}>
          <option value="auto">Automático</option><option value="jev">Somente Jev</option><option value="clef">Somente Clef</option>
        </select>
      </label>
      {settings.mode === 'clef' && <label className="settings-field">Variante Cloudflare
        <select className="settings-input" aria-label="Variante Clef" value={settings.clefModel} disabled={busy}
          onChange={event => onChange({ clefModel: event.target.value as DecisionSettings['clefModel'] })}>
          <option value="clef">Clef</option><option value="clef-flash">Clef Flash</option>
        </select>
      </label>}
    </div>
    <p className="settings-field__note">No automático, a rota inicial usa Clef para escolher ferramentas e Jev nas demais decisões de texto.
      {' '}As rotas baseadas em benchmarks públicos ainda precisam de comparação no Nexus.</p>
    <label className="settings-toggle-row">
      <span className="settings-toggle-row__copy"><strong>Analisar imagens com Clef</strong>
        <span>Envia capturas autorizadas à Cloudflare quando a tarefa precisa de visão. Configurar o token não ativa esse envio.</span></span>
      <input type="checkbox" aria-label="Analisar imagens com Clef" checked={settings.visionEnabled} disabled={busy || settings.mode === 'jev'}
        onChange={event => onChange({ visionEnabled: event.target.checked })} />
      <span className="settings-toggle-row__control" aria-hidden="true" />
    </label>
  </>;
}

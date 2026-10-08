import type { DecisionSettings } from '../../../shared/decision-models';
import { VisionConsentToggle } from './VisionConsentToggle';

export function DecisionModeControls({ settings, busy, onChange }: {
  settings: DecisionSettings; busy: boolean; onChange: (patch: Partial<DecisionSettings>) => void;
}) {
  return <>
    <div className="settings-form-grid">
      <label className="settings-field">Escolha do modelo
        <select className="settings-input" aria-label="Escolha do modelo" value={settings.mode} disabled={busy}
          onChange={event => onChange({ mode: event.target.value as DecisionSettings['mode'] })}>
          <option value="auto">Automático</option><option value="jev">Somente Jev</option><option value="clef">Somente Clef</option>
          <option value="luna">Somente Luna (beta)</option>
          <option value="together">Luna junto com Jev e Clef</option>
        </select>
      </label>
      {settings.mode === 'clef' && <label className="settings-field">Variante Cloudflare
        <select className="settings-input" aria-label="Variante Cloudflare" value={settings.clefModel} disabled={busy}
          onChange={event => onChange({ clefModel: event.target.value as DecisionSettings['clefModel'] })}>
          <option value="clef">Clef</option><option value="clef-flash">Clef Flash</option>
        </select>
      </label>}
    </div>
    <p className="settings-field__note">No Automático, a rota inicial usa Clef para escolher ferramentas e Jev nas demais decisões de texto.
      {' '}As rotas baseadas em benchmarks públicos ainda precisam de comparação no Nexus.</p>
    {(settings.mode === 'auto' || settings.mode === 'clef') && <p className="settings-field__note">No Automático e em Somente Clef, o texto de estados de panes, saídas de terminal, pedidos e candidatos de ferramentas pode ser enviado à Cloudflare.
      {' '}A guarda de despacho, a revisão de handoff, a memória e os pilotos de navegador e desktop continuam só no Jev.</p>}
    {(settings.mode === 'auto' || settings.mode === 'luna') && <p className="settings-field__note">A Luna (beta) é a Decisions API da OpenAI, modelo gpt-6-luna. No Automático ela só entra quando falta o provedor preferido.
      {' '}Em Somente Luna, o texto redigido vai à OpenAI, inclusive a guarda de despacho, a revisão de handoff, a memória e os pilotos. Sem a chave OpenAI nada disso cai no Jev.</p>}
    {settings.mode === 'together' && <p className="settings-field__note">Juntos é opt-in e faz mais de uma chamada. No texto, Jev e Luna respondem a mesma pergunta; na imagem mascarada, Clef e Luna. Os rótulos do desktop e do navegador ficam no Jev. Concordância segue pela confiança maior.
      {' '}Divergência em efeito irreversível, deny ou confirmação fica com o veredito mais restritivo. Na guarda, no handoff e na memória, o Jev não afrouxa. Quem não tiver chave fica de fora, e um provedor sozinho não é chamado no lugar.</p>}
    <VisionConsentToggle enabled={settings.visionEnabled} disabled={busy || settings.mode === 'jev'}
      audience={settings.mode === 'luna' ? 'luna' : settings.mode === 'together' ? 'together' : settings.mode === 'auto' ? 'auto' : 'clef'}
      onChange={visionEnabled => onChange({ visionEnabled })} />
  </>;
}

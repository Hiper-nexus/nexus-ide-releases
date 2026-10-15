import { CLEF_AUDIO_MODEL, hasAudioRecipientConsent, hasVisionRecipientConsent, visionRecipientsForMode, type VisionRecipient, type DecisionSettings } from '../../../shared/decision-models';
import { AudioConsentToggle } from './AudioConsentToggle';
import { VisionConsentToggle } from './VisionConsentToggle';

export function DecisionModeControls({ settings, busy, onChange }: {
  settings: DecisionSettings; busy: boolean; onChange: (patch: Partial<DecisionSettings>) => void;
}) {
  const recipients = visionRecipientsForMode(settings.mode);
  const authorized = (['clef', 'luna'] as VisionRecipient[]).filter(recipient => hasVisionRecipientConsent(settings, recipient));
  const missing = recipients.filter(recipient => !authorized.includes(recipient));
  const visualEnabled = settings.mode === 'auto' ? authorized.length > 0 : recipients.length > 0 && missing.length === 0;
  // Áudio só existe com Clef-omni numa rota que aceita Cloudflare; fora disso o schema já derruba a autorização.
  const audioAvailable = settings.clefModel === CLEF_AUDIO_MODEL && settings.mode !== 'jev' && settings.mode !== 'luna';
  const additionalConsent = settings.mode === 'auto' && visualEnabled && missing.length
    ? `Autorizar também a ${missing[0] === 'luna' ? 'OpenAI' : 'Cloudflare'}` : undefined;
  return <>
    <div className="settings-form-grid">
      <label className="settings-field">Escolha do modelo
        <select className="settings-input" aria-label="Escolha do modelo" value={settings.mode} disabled={busy}
          onChange={event => {
            const mode = event.target.value as DecisionSettings['mode'];
            onChange({ mode, ...(mode === 'jev' ? { visionEnabled: false, visionConsent: { version: 1, recipients: [] } } : {}) });
          }}>
          <option value="auto">Automático</option><option value="jev">Somente Jev</option><option value="clef">Somente Clef</option>
          <option value="luna">Somente Luna (beta)</option>
          <option value="together">Luna junto com Jev e Clef</option>
        </select>
      </label>
      {(settings.mode === 'jev' || settings.mode === 'auto' || settings.mode === 'together') && <label className="settings-field">Versão do Jev
        <select className="settings-input" aria-label="Versão do Jev" value={settings.jevModel ?? 'jev-latest'} disabled={busy}
          onChange={event => onChange({ jevModel: event.target.value as DecisionSettings['jevModel'] })}>
          <option value="jev-latest">Estável (jev-latest)</option>
          <option value="jev-1.14.0">Jev 1.14.0 (preview)</option>
          <option value="jev-preview">Preview mais recente (jev-preview)</option>
          <option value="jev-1.13.0">Jev 1.13.0 (calibração histórica)</option>
        </select>
      </label>}
      {settings.mode === 'clef' && <label className="settings-field">Variante Cloudflare
        <select className="settings-input" aria-label="Variante Cloudflare" value={settings.clefModel} disabled={busy}
          onChange={event => onChange({ clefModel: event.target.value as DecisionSettings['clefModel'] })}>
          <option value="clef">Clef — texto e imagem; US$ 0,24/M</option>
          <option value="clef-flash">Clef Flash — texto e imagem, contexto de 24 mil tokens; US$ 0,038/M</option>
          <option value="clef-omni">Clef-omni — texto, imagem e áudio; US$ 0,15/M</option>
        </select>
      </label>}
    </div>
    {(settings.mode === 'jev' || settings.mode === 'auto' || settings.mode === 'together') && <p className="settings-field__note">
      O preview 1.14 precisa de reavaliação dos limiares medidos em 1.13. Se a API recusar o modelo, a consulta tenta o estável.
      {' '}O teste de conexão mostra a versão que respondeu. NEXUS_JEV_MODEL, quando configurado, prevalece sobre esta escolha.
    </p>}
    {settings.mode === 'clef' && <p className="settings-field__note">Preços por milhão de tokens de entrada. O Clef aceita até 65.536 tokens de contexto,
      {' '}o Clef-omni até 64.000 e o Flash até 24.576: em estados longos, prefira Clef ou Clef-omni.
      {' '}A variante escolhida vale para todas as decisões que vão ao Clef, inclusive o julgamento visual do navegador.</p>}
    <p className="settings-field__note">No Automático, a rota inicial usa Clef para escolher ferramentas e Jev nas demais decisões de texto.
      {' '}As rotas baseadas em benchmarks públicos ainda precisam de comparação no Nexus.</p>
    {settings.mode === 'auto' && <p className="settings-field__note">No Automático, o texto de estados de panes, saídas de terminal, pedidos e candidatos de ferramentas pode ser enviado à Cloudflare.
      {' '}A guarda de despacho, a revisão de handoff, a memória e os pilotos de navegador e desktop continuam só no Jev.</p>}
    {settings.mode === 'clef' && <p className="settings-field__note">Em Somente Clef, o texto de estados de panes, saídas de terminal, pedidos e candidatos de ferramentas pode ser enviado à Cloudflare.
      {' '}A guarda de despacho, a revisão de handoff, a memória e os pilotos de navegador e desktop ficam sem rota e sem julgamento do Jev.</p>}
    {(settings.mode === 'auto' || settings.mode === 'luna') && <p className="settings-field__note">A Luna (beta) é a Decisions API da OpenAI, modelo gpt-6-luna. No Automático ela só entra quando falta o provedor preferido.
      {' '}Em Somente Luna, o texto redigido vai à OpenAI, inclusive a guarda de despacho, a revisão de handoff, a memória e os pilotos. Sem a chave OpenAI nada disso cai no Jev.</p>}
    {settings.mode === 'together' && <p className="settings-field__note">Antes de ligar Juntos: com as três credenciais, o texto de segurança de dispatchGuard, handoffReview e memoryDistill também vai para o Clef.
      {' '}Juntos é opt-in e faz mais de uma chamada. No texto comum, Jev e Luna respondem a mesma pergunta; na imagem mascarada, Clef e Luna. A regra de duas credenciais vale para o conjunto: os rótulos de computerTool e browserTool continuam uma chamada só do Jev. Concordância segue pela confiança maior.
      {' '}Divergência em efeito irreversível, deny ou confirmação fica com o veredito mais restritivo. Na guarda, no handoff e na memória, o Jev não afrouxa quando está na jogada. Quem não tiver chave fica de fora: Luna e Clef sem o Jev continuam conjunto.</p>}
    {settings.visionEnabled && authorized.length > 0 && <p className="settings-field__note">
      Envio de imagens autorizado para {authorized.map(recipient => recipient === 'clef' ? 'Cloudflare' : 'OpenAI').join(' e ')}.
      {!visualEnabled && ' O modo escolhido precisa de uma nova autorização antes de enviar capturas.'}
    </p>}
    <VisionConsentToggle enabled={visualEnabled} additionalConsent={additionalConsent} disabled={busy || settings.mode === 'jev'}
      audience={settings.mode === 'luna' ? 'luna' : settings.mode === 'together' ? 'together' : settings.mode === 'auto' ? 'auto' : 'clef'}
      onChange={visionEnabled => onChange({ visionEnabled, visionConsent: { version: 1,
        recipients: visionEnabled ? [...new Set([...authorized, ...recipients])] : [],
      } })} />
    {audioAvailable && <AudioConsentToggle enabled={hasAudioRecipientConsent(settings, 'clef')} disabled={busy}
      onChange={enabled => onChange({ audioConsent: { version: 1, recipients: enabled ? ['clef'] : [] } })} />}
  </>;
}

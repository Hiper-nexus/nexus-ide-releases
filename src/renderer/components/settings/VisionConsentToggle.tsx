import { useEffect, useState } from 'react';

/** Three plain sentences: what leaves, what is hidden, and what that hiding does not promise. */
const VISION_CONSENT = [
  'Ao ligar, capturas da aba do navegador são enviadas à Cloudflare para o Clef julgar o que aparece nelas.',
  'Antes do envio, o Nexus oculta campos editáveis, segredos reconhecidos, quadros e mídia; abas com o seu perfil pessoal (logins reais) nunca são enviadas.',
  'Essa ocultação é parcial e não garante esconder dados pessoais: nomes, e-mails, números e fundos de página podem aparecer na captura.',
] as const;

interface VisionConsentToggleProps { enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void }

/** Turning the send ON always passes through an explicit confirmation; turning it off is immediate. */
export function VisionConsentToggle({ enabled, disabled, onChange }: VisionConsentToggleProps) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (disabled || enabled) setConfirming(false); }, [disabled, enabled]);
  return <>
    <label className="settings-toggle-row">
      <span className="settings-toggle-row__copy"><strong>Analisar imagens com Clef</strong>
        <span>Envia capturas autorizadas à Cloudflare quando a tarefa precisa de visão. Configurar o token não ativa esse envio.</span></span>
      <input type="checkbox" aria-label="Analisar imagens com Clef" checked={enabled} disabled={disabled}
        onChange={event => { if (event.target.checked) setConfirming(true); else onChange(false); }} />
      <span className="settings-toggle-row__control" aria-hidden="true" />
    </label>
    {confirming && <div className="decision-models__confirm" role="group" aria-label="Confirmar envio de imagens">
      {VISION_CONSENT.map(sentence => <p key={sentence} className="settings-field__note">{sentence}</p>)}
      <div className="settings-row decision-models__actions">
        <button className="settings-btn" type="button" onClick={() => { setConfirming(false); onChange(true); }}>Ativar análise de imagens</button>
        <button className="settings-btn settings-btn--sm" type="button" onClick={() => setConfirming(false)}>Cancelar</button>
      </div>
    </div>}
  </>;
}

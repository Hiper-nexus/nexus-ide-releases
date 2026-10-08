import { useEffect, useState } from 'react';

/** Three plain sentences: what leaves, what is hidden, and what that hiding does not promise. */
const MASK_SENTENCES = [
  'Antes do envio, o Nexus oculta campos editáveis, segredos reconhecidos, quadros e mídia; abas com o seu perfil pessoal (logins reais) nunca são enviadas.',
  'Essa ocultação é parcial e não garante esconder dados pessoais: nomes, e-mails, números e fundos de página podem aparecer na captura.',
] as const;
const CLEF_LEAD = 'Ao ligar, capturas da aba do navegador são enviadas à Cloudflare para o Clef julgar o que aparece nelas.';
const LUNA_LEAD = 'Ao ligar, capturas da aba do navegador são enviadas à OpenAI para a Luna (beta) julgar o que aparece nelas.';
const AUTO_EXTRA = 'Se a Cloudflare não estiver disponível, a mesma captura mascarada pode ir à OpenAI (Decisions API, Luna, beta).';

const VISION_COPY = {
  clef: { label: 'Analisar imagens com Clef', aria: 'Analisar imagens com Clef',
    hint: 'Envia capturas autorizadas à Cloudflare quando a tarefa precisa de visão. Configurar o token não ativa esse envio.',
    sentences: [CLEF_LEAD, ...MASK_SENTENCES] },
  auto: { label: 'Analisar imagens com Clef', aria: 'Analisar imagens com Clef',
    hint: 'Envia capturas autorizadas à Cloudflare ou, se ela não for a rota, à OpenAI (Luna, beta). Configurar o token não ativa esse envio.',
    sentences: [CLEF_LEAD, ...MASK_SENTENCES, AUTO_EXTRA] },
  luna: { label: 'Analisar imagens com a Luna', aria: 'Analisar imagens com a Luna',
    hint: 'Envia capturas autorizadas à OpenAI quando a tarefa precisa de visão. A chave da OpenAI não ativa esse envio.',
    sentences: [LUNA_LEAD, ...MASK_SENTENCES] },
} as const;

interface VisionConsentToggleProps {
  enabled: boolean; disabled: boolean; audience?: keyof typeof VISION_COPY; onChange: (enabled: boolean) => void;
}

/** Turning the send ON always passes through an explicit confirmation; turning it off is immediate. */
export function VisionConsentToggle({ enabled, disabled, audience = 'clef', onChange }: VisionConsentToggleProps) {
  const copy = VISION_COPY[audience];
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (disabled || enabled) setConfirming(false); }, [disabled, enabled]);
  return <>
    <label className="settings-toggle-row">
      <span className="settings-toggle-row__copy"><strong>{copy.label}</strong>
        <span>{copy.hint}</span></span>
      <input type="checkbox" aria-label={copy.aria} checked={enabled} disabled={disabled}
        onChange={event => { if (event.target.checked) setConfirming(true); else onChange(false); }} />
      <span className="settings-toggle-row__control" aria-hidden="true" />
    </label>
    {confirming && <div className="decision-models__confirm" role="group" aria-label="Confirmar envio de imagens">
      {copy.sentences.map(sentence => <p key={sentence} className="settings-field__note">{sentence}</p>)}
      <div className="settings-row decision-models__actions">
        <button className="settings-btn" type="button" onClick={() => { setConfirming(false); onChange(true); }}>Ativar análise de imagens</button>
        <button className="settings-btn settings-btn--sm" type="button" onClick={() => setConfirming(false)}>Cancelar</button>
      </div>
    </div>}
  </>;
}

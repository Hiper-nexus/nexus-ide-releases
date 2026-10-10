import { useEffect, useState } from 'react';

/** O que sai, quando sai e o que não é prometido — mesma doutrina da autorização de imagens. */
const AUDIO_SENTENCES = [
  'Ao ligar, cada vez que o detector local do microfone ouvir “Hey Jarvis”, os cerca de 2 segundos de áudio que terminam nesse instante (a frase e o que soou logo antes dela) são enviados à Cloudflare. O Clef-omni ouve esse trecho para ajudar a descartar ativações de TV ou som ambiente.',
  'Nada é enviado sem uma detecção local, e só com esta opção ligada, o Clef-omni escolhido e o token da Cloudflare configurado. Quando o detector se engana, o trecho enviado pode conter som ambiente ou a conversa de quem estiver por perto.',
  'Com a opção ligada, a ativação pode esperar até cerca de 1,5 s pela resposta. Se a Cloudflare demorar, falhar ou ficar em dúvida, a ativação segue como hoje; ela só é descartada quando o Clef-omni indica, com alta confiança, que era TV ou som ambiente.',
] as const;

interface AudioConsentToggleProps { enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void }

/** Autorização própria para áudio: ligar sempre passa por confirmação explícita; desligar é imediato. */
export function AudioConsentToggle({ enabled, disabled, onChange }: AudioConsentToggleProps) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (disabled || enabled) setConfirming(false); }, [disabled, enabled]);
  return <>
    <label className="settings-toggle-row">
      <span className="settings-toggle-row__copy"><strong>Confirmar ativação por voz com Clef-omni</strong>
        <span>Envia à Cloudflare cerca de 2 s de áudio a cada detecção de “Hey Jarvis”, somente quando ligado. Configurar o token ou autorizar imagens não ativa esse envio.</span></span>
      <input type="checkbox" aria-label="Confirmar ativação por voz com Clef-omni" checked={enabled} disabled={disabled}
        onChange={event => { if (event.target.checked) setConfirming(true); else onChange(false); }} />
      <span className="settings-toggle-row__control" aria-hidden="true" />
    </label>
    {confirming && <div className="decision-models__confirm" role="group" aria-label="Confirmar envio de áudio">
      {AUDIO_SENTENCES.map(sentence => <p key={sentence} className="settings-field__note">{sentence}</p>)}
      <div className="settings-row decision-models__actions">
        <button className="settings-btn" type="button" onClick={() => { setConfirming(false); onChange(true); }}>Ativar envio de áudio</button>
        <button className="settings-btn settings-btn--sm" type="button" onClick={() => setConfirming(false)}>Cancelar</button>
      </div>
    </div>}
  </>;
}

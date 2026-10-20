import { useState } from 'react';
import type { MediaProviderInfo } from '../../../shared/media-types';
import { credentialLinkForKeySlot } from '../../../shared/credential-links';
import { openExternalFromAnchor } from '../../lib/open-external';

/**
 * Campo de chave de um serviço de mídia (colar, conectar, trocar, remover).
 * A chave vai direto ao cofre do Main por `media.setKey`; o renderer nunca a
 * lê de volta. Usado em Serviços de mídia e em Modelos de mídia (F-1615).
 */
export function MediaKeyField({
  provider,
  onSaved,
}: {
  provider: MediaProviderInfo;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const credentialLink = credentialLinkForKeySlot({
    envVar: provider.envVar,
    providerId: provider.id,
  });

  async function updateKey(value: string) {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await window.nexus.media.setKey(provider.id, value);
      if (!result.ok) {
        setStatus({
          tone: 'danger',
          text: value
            ? 'Não foi possível salvar a chave. Tente novamente.'
            : 'Não foi possível remover a chave. Tente novamente.',
        });
        return;
      }
      setDraft('');
      setStatus({ tone: 'ok', text: value ? 'Chave salva' : 'Chave removida' });
      onSaved();
    } catch {
      setStatus({
        tone: 'danger',
        text: 'Não foi possível atualizar a chave. Tente novamente.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prov__key media-key">
      <div className="prov__key-row">
        <span className="prov__key-label">
          Chave de acesso
          {credentialLink && (
            <>
              {' · '}
              <a
                className="settings-link"
                href={credentialLink.url}
                onClick={(e) =>
                  openExternalFromAnchor(e, credentialLink.url)
                }
              >
                Obter chave em {credentialLink.label}
              </a>
            </>
          )}
        </span>
      </div>
      <div className="prov__key-input">
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`Chave de acesso de ${provider.label}`}
          value={draft}
          placeholder={
            provider.envVar === 'HIGGSFIELD_API_KEY'
              ? 'Cole no formato ID:SEGREDO (os dois valores da chave da Higgsfield)'
              : provider.hasKey
                ? 'Cole uma nova chave para substituir'
                : 'Cole sua chave de acesso'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && draft && void updateKey(draft)}
        />
      </div>
      <div className="settings-row media-key__actions">
        <button type="button" className="settings-btn settings-btn--primary"
          onClick={() => void updateKey(draft)} disabled={busy || !draft}>
          {busy ? 'Salvando…' : provider.hasKey ? 'Salvar chave' : 'Conectar'}
        </button>
        {provider.hasKey && <button type="button" className="settings-btn"
          onClick={() => void updateKey('')} disabled={busy}>Remover chave</button>}
      </div>
      {status && (
        <p
          className={`prov__status media-key__status media-key__status--${status.tone}`}
          role="status"
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

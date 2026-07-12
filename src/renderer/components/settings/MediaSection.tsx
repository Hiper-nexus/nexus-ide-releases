import { useEffect, useState } from 'react';
import type {
  MediaProviderInfo,
  MediaUsageTotals,
} from '../../../shared/media-types';
import { credentialLinkForKeySlot } from '../../../shared/credential-links';
import { openExternalFromAnchor } from '../../lib/open-external';

/**
 * Settings → Mídia: providers de geração (imagem/vídeo/voz) que viram MCP
 * tools para os agentes (nexus_image_generate, nexus_video_generate,
 * nexus_audio_generate). A key fica no Keychain do processo principal — o
 * agente só dispara a tool e recebe o caminho do arquivo gerado no workspace.
 */

const TOOL_BY_KIND: Record<string, string> = {
  image: 'nexus_image_generate',
  video: 'nexus_video_generate',
  audio: 'nexus_audio_generate',
};

function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function MediaKeyField({
  provider,
  onSaved,
}: {
  provider: MediaProviderInfo;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const credentialLink = credentialLinkForKeySlot({
    envVar: provider.envVar,
    providerId: provider.id,
  });

  async function save() {
    setBusy(true);
    const result = await window.nexus.media.setKey(provider.id, draft);
    setBusy(false);
    setDraft('');
    setStatus(result.ok ? 'key salva no Keychain' : result.error ?? 'falhou');
    onSaved();
  }

  async function clear() {
    setBusy(true);
    await window.nexus.media.setKey(provider.id, '');
    setBusy(false);
    setStatus('key removida');
    onSaved();
  }

  return (
    <div className="prov__key">
      <div className="prov__key-row">
        <span className="prov__key-label">
          API key <code className="prov__env"> → {provider.envVar}</code>
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
                obter em {credentialLink.label}
              </a>
            </>
          )}
        </span>
      </div>
      <div className="prov__key-input">
        <input
          className="settings-input"
          type="password"
          value={draft}
          placeholder={provider.hasKey ? '•••• (substituir)' : 'colar API key'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && draft && void save()}
        />
        <button
          className="settings-btn"
          onClick={() => void save()}
          disabled={busy || !draft}
        >
          Salvar
        </button>
        {provider.hasKey && (
          <button
            className="settings-btn settings-btn--danger"
            onClick={() => void clear()}
            disabled={busy}
          >
            Limpar
          </button>
        )}
      </div>
      {status && <p className="prov__status">{status}</p>}
    </div>
  );
}

export function MediaSection() {
  const [providers, setProviders] = useState<MediaProviderInfo[]>([]);
  const [totals, setTotals] = useState<MediaUsageTotals>({
    generations: 0,
    costUsd: 0,
  });

  async function refresh() {
    const [list, usage] = await Promise.all([
      window.nexus.media.listProviders(),
      window.nexus.media.usageTotals(),
    ]);
    setProviders(list);
    setTotals(usage);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <section className="settings-section" aria-label="Mídia">
      <h2 className="settings-section__title">MÍDIA · GERAÇÃO</h2>
      <p className="settings-section__hint">
        Providers de imagem, vídeo e voz que viram MCP tools pros agentes. A
        key fica no processo principal (Keychain) — o agente só dispara a tool
        e recebe o caminho do arquivo gerado no workspace. Imagem flagship:
        Seedream 5.0 Pro (ByteDance, alias seedream / seedream-5-pro). Vídeo:
        Seedance 2.0, Veo 3.1, Kling, Sora… Aliases: seedream, seedance, veo…
      </p>
      {totals.generations > 0 && (
        <p className="settings-section__hint">
          Custo acumulado de mídia: <strong>{formatUsd(totals.costUsd)}</strong>{' '}
          · {totals.generations}{' '}
          {totals.generations === 1 ? 'geração' : 'gerações'}
        </p>
      )}
      {providers.map((provider) => (
        <div key={provider.id} className="settings-card">
          <div className="prov__key-row">
            <span className="prov__key-label">
              {provider.label}{' '}
              <code className="prov__env">{TOOL_BY_KIND[provider.kind]}</code>
            </span>
            <span
              className={`settings-chip ${provider.hasKey ? 'settings-chip--ok' : 'settings-chip--warn'}`}
            >
              {provider.hasKey ? provider.maskedKey ?? 'ok' : 'sem key'}
            </span>
          </div>
          <p className="settings-section__hint">
            default: <code>{provider.defaultModel}</code>
          </p>
          <p className="settings-section__hint">
            modelos: {provider.models.join(' · ')}
          </p>
          <MediaKeyField provider={provider} onSaved={() => void refresh()} />
        </div>
      ))}
    </section>
  );
}

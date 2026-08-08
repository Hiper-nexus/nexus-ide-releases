import { useEffect, useMemo, useState } from 'react';
import type {
  MediaKind,
  MediaProviderInfo,
  MediaUsageTotals,
} from '../../../shared/media-types';
import { credentialLinkForKeySlot } from '../../../shared/credential-links';
import { openExternalFromAnchor } from '../../lib/open-external';
import { useMediaStudioStore } from '../../state/media-studio-store';
import { ActionCard } from '../ActionCard';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Settings → Mídia: providers de geração (imagem/vídeo/voz) que viram MCP
 * tools para os agentes (nexus_image_generate, nexus_video_generate,
 * nexus_audio_generate). Keys no Keychain do main process.
 */

const TOOL_BY_KIND: Record<MediaKind, string> = {
  image: 'nexus_image_generate',
  video: 'nexus_video_generate',
  audio: 'nexus_audio_generate',
};

const KIND_LABEL: Record<MediaKind, string> = {
  image: 'imagem',
  video: 'vídeo',
  audio: 'voz',
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
      </div>
      <div className="action-card-row">
        <ActionCard
          icon="key"
          title="Salvar key"
          subtitle="Keychain seguro"
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={busy || !draft}
        />
        {provider.hasKey && (
          <ActionCard
            icon="close"
            title="Limpar"
            subtitle="Remove a key"
            variant="danger"
            size="sm"
            onClick={() => void clear()}
            disabled={busy}
          />
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
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const [list, usage] = await Promise.all([
      window.nexus.media.listProviders(),
      window.nexus.media.usageTotals(),
    ]);
    setProviders(list);
    setTotals(usage);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const withKey = providers.filter((p) => p.hasKey).length;
  const byKind = useMemo(() => {
    const order: MediaKind[] = ['image', 'video', 'audio'];
    return order
      .map((kind) => ({
        kind,
        items: providers.filter((p) => p.kind === kind),
      }))
      .filter((g) => g.items.length > 0);
  }, [providers]);

  return (
    <section className="arsenal-section" aria-label="Mídia">
      <header className="arsenal-section__intro">
        <SettingsSectionTitle>Mídia</SettingsSectionTitle>
        <p className="settings-detail__hint">
          Providers de imagem, vídeo e voz que viram MCP tools para os agentes.
          A key fica no Keychain; o agente só recebe o caminho do arquivo
          gerado no workspace.
        </p>
      </header>

      <div className="arsenal-fleet" role="status">
        <span className="arsenal-fleet__stat">
          <strong>{loading ? '…' : providers.length}</strong> providers
        </span>
        <span className="arsenal-fleet__sep" aria-hidden="true">
          ·
        </span>
        <span className="arsenal-fleet__stat">
          <strong>{withKey}</strong> com key
        </span>
        {totals.generations > 0 && (
          <>
            <span className="arsenal-fleet__sep" aria-hidden="true">
              ·
            </span>
            <span className="arsenal-fleet__stat">
              {totals.generations}{' '}
              {totals.generations === 1 ? 'geração' : 'gerações'} ·{' '}
              {formatUsd(totals.costUsd)}
            </span>
          </>
        )}
      </div>

      {loading && (
        <p className="settings-detail__hint" role="status">
          Carregando providers de mídia…
        </p>
      )}

      <div className="action-card-row">
        <ActionCard
          icon="vision"
          title="Abrir Estúdio de Mídia"
          subtitle="Gere imagens e vídeos sem agente"
          variant="primary"
          size="sm"
          onClick={() => useMediaStudioStore.getState().show()}
        />
      </div>

      {!loading && providers.length === 0 && (
        <p className="arsenal-empty">
          Nenhum provider de mídia no inventário.
        </p>
      )}

      {byKind.map(({ kind, items }) => (
        <div key={kind} className="arsenal-band">
          <h4 className="arsenal-band__label">
            {KIND_LABEL[kind]}{' '}
            <span className="arsenal-band__count">{items.length}</span>
          </h4>
          <div className="arsenal-media-grid">
            {items.map((provider) => (
              <article key={provider.id} className="arsenal-media-card">
                <div className="arsenal-media-card__head">
                  <div className="arsenal-media-card__titles">
                    <span className="arsenal-media-card__name">
                      {provider.label}
                    </span>
                    <code className="arsenal-media-card__tool">
                      {TOOL_BY_KIND[provider.kind]}
                    </code>
                  </div>
                  <span
                    className={`prov__badge ${provider.hasKey ? 'prov__badge--ok' : 'prov__badge--warn'}`}
                  >
                    {provider.hasKey ? provider.maskedKey ?? 'ok' : 'sem key'}
                  </span>
                </div>
                <p className="arsenal-media-card__meta">
                  default: <code>{provider.defaultModel}</code>
                </p>
                <p className="arsenal-media-card__meta">
                  modelos: {provider.models.join(' · ')}
                </p>
                <MediaKeyField
                  provider={provider}
                  onSaved={() => void refresh()}
                />
              </article>
            ))}
          </div>
        </div>
      ))}

      <p className="settings-detail__hint arsenal-section__foot">
        Imagem flagship: Seedream 5.0 Pro. Vídeo: Seedance, Veo, Kling, Sora…
        Aliases: seedream, seedance, veo…
      </p>
    </section>
  );
}

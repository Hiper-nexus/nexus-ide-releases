import { useMemo, useState } from 'react';
import type {
  MediaKind,
  MediaProviderInfo,
  MediaUsageTotals,
} from '../../../shared/media-types';
import { credentialLinkForKeySlot } from '../../../shared/credential-links';
import { openExternalFromAnchor } from '../../lib/open-external';
import { useMediaStudioStore } from '../../state/media-studio-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { ProviderLogo } from '../ProviderLogo';
import { ActionCard, EmptyState } from '../ActionCard';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { MyVoiceCard } from './MyVoiceCard';
import { MediaBudgetCard } from './MediaBudgetCard';
import { useProductFlags } from '../../lib/use-product-flags';
import { FEATURE_FLAG_IDS } from '../../../shared/feature-flags';
import { useCatalogResource } from './use-catalog-resource';

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
          placeholder={provider.hasKey ? 'Cole uma nova chave para substituir' : 'Cole sua chave de acesso'}
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

async function readMediaSettings(): Promise<{
  providers: MediaProviderInfo[];
  totals: MediaUsageTotals | null;
}> {
  const providers = await window.nexus.media.listProviders();
  // F-1589: serviços e chaves são globais; só os totais são do projeto
  // aberto. Sem projeto (null) ou com a leitura falhando, a tela continua
  // mostrando os serviços para conectar a chave.
  const totals = await window.nexus.media.usageTotals().catch(() => null);
  return { providers, totals };
}

const EMPTY_PROVIDERS: MediaProviderInfo[] = [];

export function MediaSection() {
  const { data, loading, error, reload: refresh } = useCatalogResource(
    readMediaSettings, 'Não foi possível carregar os serviços de mídia.',
  );
  const providers = data?.providers ?? EMPTY_PROVIDERS;
  const totals = data?.totals ?? null;
  const productFlags = useProductFlags();

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
    <section className="arsenal-section media-section" aria-label="Mídia">
      <header className="arsenal-section__intro">
        <SettingsSectionTitle>Mídia</SettingsSectionTitle>
        <p className="settings-detail__hint">
          Conecte serviços para criar imagens, vídeos e voz nas suas missões.
          Conexão e catálogo de modelos são funções separadas, com caminho direto entre elas.
        </p>
      </header>

      {!error && <div className="arsenal-fleet media-section__fleet" role="status">
        <span
          className={`arsenal-fleet__led ${
            loading || providers.length === 0
              ? ''
              : withKey === providers.length
                ? 'arsenal-fleet__led--ok'
                : 'arsenal-fleet__led--warn'
          }`}
          aria-hidden="true"
        />
        <span className="arsenal-fleet__stat">
          <strong>{loading ? '…' : providers.length}</strong> serviços
        </span>
        <span className="arsenal-fleet__sep" aria-hidden="true">
          ·
        </span>
        <span className="arsenal-fleet__stat">
          <strong>{withKey}</strong> conectados
        </span>
        {totals !== null && totals.generations > 0 && (
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
        <button
          type="button"
          className="settings-btn settings-btn--sm media-section__fleet-refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          Atualizar
        </button>
      </div>}

      {error && <div role="alert">
        <p className="settings-error">{error}</p>
        <button type="button" className="settings-btn" onClick={() => void refresh()}>Tentar novamente</button>
      </div>}

      {loading && (
        <p className="settings-detail__hint" role="status">
          Carregando serviços de mídia…
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
        <ActionCard
          icon="grid"
          title="Ver catálogo de modelos"
          subtitle="Modelos disponíveis por serviço"
          size="sm"
          onClick={() =>
            useProductNavigationStore.getState().openSettings('media-catalog')
          }
        />
      </div>

      {!loading && !error && providers.length === 0 && (
        <EmptyState
          icon="vision"
          title="Nenhum serviço de mídia disponível"
          body={<p>O catálogo de serviços respondeu vazio. Tente atualizar.</p>}
          action={
            <button
              type="button"
              className="settings-btn"
              onClick={() => void refresh()}
            >
              Verificar novamente
            </button>
          }
        />
      )}

      {!error && byKind.map(({ kind, items }) => (
        <div key={kind} className="arsenal-band">
          <h3 className="arsenal-band__label media-section__band-label">
            {KIND_LABEL[kind]}{' '}
            <span className="arsenal-band__count">{items.length}</span>
          </h3>
          <div className="arsenal-media-grid">
            {items.map((provider) => (
              <article
                key={provider.id}
                className="arsenal-media-card media-card"
                data-connected={provider.hasKey ? 'true' : undefined}
              >
                <div className="arsenal-media-card__head">
                  <ProviderLogo adapterId={provider.id.split('-')[0]} label={provider.label} size="sm" />
                  <div className="arsenal-media-card__titles">
                    <span className="arsenal-media-card__name">
                      {provider.label}
                    </span>
                    <span className="media-card__sub">
                      {provider.models.length}{' '}
                      {provider.models.length === 1 ? 'modelo' : 'modelos'} ·{' '}
                      <code>{TOOL_BY_KIND[provider.kind]}</code>
                    </span>
                  </div>
                  <span
                    className={`settings-chip media-card__state ${provider.hasKey ? 'settings-chip--ok' : 'settings-chip--warn'}`}
                  >
                    <span className="media-state-dot" aria-hidden="true" />
                    {provider.hasKey ? 'Conectado' : 'Não conectado'}
                  </span>
                </div>
                <details className="settings-advanced-field media-card__details">
                  <summary>Modelos e detalhes técnicos</summary>
                  <p className="arsenal-media-card__meta">
                    Modelo padrão: <code>{provider.defaultModel}</code>
                  </p>
                  <p className="arsenal-media-card__meta">
                    Disponíveis: {provider.models.join(' · ')}
                  </p>
                  <p className="arsenal-media-card__meta">
                    Ferramenta: <code>{TOOL_BY_KIND[provider.kind]}</code>
                  </p>
                  <p className="arsenal-media-card__meta">
                    Variável de ambiente: <code>{provider.envVar}</code>
                  </p>
                </details>
                {provider.hasKey ? (
                  <details className="settings-advanced-field media-card__details">
                    <summary>Gerenciar conexão</summary>
                    <MediaKeyField provider={provider} onSaved={() => void refresh()} />
                  </details>
                ) : (
                  <div
                    className="media-card__connect"
                    role="group"
                    aria-label={`Conectar ${provider.label}`}
                  >
                    <MediaKeyField provider={provider} onSaved={() => void refresh()} />
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>
      ))}

      {!error && !loading && (
        <MyVoiceCard
          elevenLabsConnected={providers.some((provider) => provider.id === 'elevenlabs' && provider.hasKey)}
          geminiConnected={providers.some((provider) => (provider.id === 'google-image' || provider.id === 'google-video') && provider.hasKey)}
          canCreate={productFlags[FEATURE_FLAG_IDS.mediaVideoStudio] === true}
        />
      )}
      {/* F-1606: o teto entra junto com o estúdio (chave interna). */}
      {!error && !loading && productFlags[FEATURE_FLAG_IDS.mediaVideoStudio] === true && <MediaBudgetCard />}
    </section>
  );
}

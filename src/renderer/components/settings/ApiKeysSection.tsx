import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaProviderId, MediaProviderInfo } from '../../../shared/media-types';
import type { VoiceApiKeyStatus, VoiceRuntimeInfo } from '../../../shared/voice-ipc';
import type { JevStatus } from '../../../shared/jev-ipc';
import { credentialLinkForEnv } from '../../../shared/credential-links';
import { openExternalFromAnchor } from '../../lib/open-external';
import { platformCopy } from '../../lib/platform-copy';
import { useProviderStore } from '../../state/provider-store';
import { useVoiceStore } from '../../voice/voice-store';
import { ProviderLogo } from '../ProviderLogo';
import { PixelIcon } from '../PixelIcon';
import { EmptyState } from '../ActionCard';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { DecisionModelsSection } from './DecisionModelsSection';

export interface SystemApiKeyDef {
  id: string;
  logoId: string;
  envVar: string;
  title: string;
  description: string;
  category: 'core' | 'voice' | 'media' | 'models';
  docLink: string;
  docLabel: string;
  adapterId?: string;
  mediaProviderIds?: MediaProviderId[];
  placeholder?: string;
}

export const SYSTEM_API_KEYS: readonly SystemApiKeyDef[] = [
  {
    id: 'gemini',
    logoId: 'gemini',
    envVar: 'GEMINI_API_KEY',
    title: 'Google Gemini',
    description:
      'Jarvis Live (Gemini Live), transcrição de fala STT, Antigravity/Gemini CLI e geração de imagens e vídeos no Estúdio de Mídia (Gemini Flash Image e Gemini Omni Flash).',
    category: 'core',
    docLink: 'https://aistudio.google.com/app/apikey',
    docLabel: 'Google AI Studio',
    adapterId: 'agy',
    mediaProviderIds: ['google-image', 'google-video'],
    placeholder: 'AIzaSy...',
  },
  {
    id: 'grok',
    logoId: 'grok',
    envVar: 'XAI_API_KEY',
    title: 'Grok (xAI)',
    description:
      'Voz oficial da assistente Jarvis em tempo real (Grok Voice), CLI do Grok e geração de imagens e vídeos no Estúdio de Mídia (Grok Imagine).',
    category: 'core',
    docLink: 'https://console.x.ai/',
    docLabel: 'xAI Console',
    adapterId: 'grok',
    mediaProviderIds: ['xai-image', 'xai-video'],
    placeholder: 'xai-...',
  },
  {
    id: 'groq',
    logoId: 'groq',
    envVar: 'GROQ_API_KEY',
    title: 'Groq Cloud',
    description:
      'Ditado ultra-rápido Space+Groq (Whisper STT em milissegundos) e inferência em modelos rápidos Llama/Mixtral.',
    category: 'voice',
    docLink: 'https://console.groq.com/keys',
    docLabel: 'GroqCloud Console',
    placeholder: 'gsk_...',
  },
  {
    id: 'openai',
    logoId: 'openai',
    envVar: 'OPENAI_API_KEY',
    title: 'OpenAI',
    description:
      'Jarvis Realtime (conversa contínua via WebSocket), Codex CLI, modelos GPT-4o/o1/o3, Whisper STT e DALL-E 3. Esta chave também é a da Decisions API (Luna, beta) em Modelos de decisão.',
    category: 'core',
    docLink: 'https://platform.openai.com/api-keys',
    docLabel: 'OpenAI Platform',
    adapterId: 'codex',
    mediaProviderIds: ['openai-image'],
    placeholder: 'sk-...',
  },
  {
    id: 'claude',
    logoId: 'claude',
    envVar: 'ANTHROPIC_API_KEY',
    title: 'Anthropic Claude',
    description:
      'Claude Code CLI, Claude 3.7 Sonnet (com raciocínio híbrido) e Claude 3 Opus.',
    category: 'core',
    docLink: 'https://platform.claude.com/settings/keys',
    docLabel: 'Claude Console',
    adapterId: 'claude',
    placeholder: 'sk-ant-...',
  },
  {
    id: 'elevenlabs',
    logoId: 'elevenlabs',
    envVar: 'ELEVENLABS_API_KEY',
    title: 'ElevenLabs',
    description:
      'Síntese de voz neural hiper-realista para a assistente Jarvis (TTS) e narração no Estúdio de Mídia.',
    category: 'voice',
    docLink: 'https://elevenlabs.io/app/settings/api-keys',
    docLabel: 'ElevenLabs Console',
    mediaProviderIds: ['elevenlabs'],
    placeholder: 'xi_...',
  },
  {
    id: 'deepseek',
    logoId: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    title: 'DeepSeek',
    description:
      'Modelos DeepSeek-V3 e DeepSeek-R1 com alta performance e excelente custo-benefício em raciocínio.',
    category: 'models',
    docLink: 'https://platform.deepseek.com/api_keys',
    docLabel: 'DeepSeek Platform',
    adapterId: 'deepseek',
    placeholder: 'sk-...',
  },
  {
    id: 'kimi',
    logoId: 'kimi',
    envVar: 'MOONSHOT_API_KEY',
    title: 'Moonshot / Kimi',
    description:
      'Kimi CLI e modelos Moonshot para análise de código e tarefas longas com janela ampliada.',
    category: 'models',
    docLink: 'https://platform.kimi.ai/',
    docLabel: 'Kimi Platform',
    adapterId: 'kimi',
    placeholder: 'sk-...',
  },
  {
    id: 'replicate',
    logoId: 'replicate',
    envVar: 'REPLICATE_API_TOKEN',
    title: 'Replicate',
    description:
      'Estúdio de Mídia para geração de imagens e vídeos com modelos open-source (Flux.1 Schnell, SDXL, etc.).',
    category: 'media',
    docLink: 'https://replicate.com/account/api-tokens',
    docLabel: 'Replicate Tokens',
    mediaProviderIds: ['replicate-image', 'replicate-video'],
    placeholder: 'r8_...',
  },
  {
    id: 'typesafe',
    logoId: 'typesafe',
    envVar: 'TYPESAFE_API_KEY',
    title: 'TypeSafe (Jev)',
    description:
      'Juiz tipado do piloto automático do Nexus: revisa a evidência dos handoffs, alimenta a tool nexus_judge dos agentes e as triagens internas. Não gera texto — só decisões com probabilidade calibrada.',
    category: 'core',
    docLink: 'https://console.typesafe.ai/settings/keys',
    docLabel: 'TypeSafe Console',
    placeholder: 'apikey_...',
  },
  {
    id: 'openrouter',
    logoId: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    title: 'OpenRouter',
    description:
      'Gateway único para acessar centenas de modelos de diferentes provedores com rate limit compartilhado.',
    category: 'models',
    docLink: 'https://openrouter.ai/settings/keys',
    docLabel: 'OpenRouter Keys',
    placeholder: 'sk-or-...',
  },
];

const CATEGORY_ORDER: readonly SystemApiKeyDef['category'][] = [
  'core',
  'voice',
  'media',
  'models',
];

const CATEGORY_META: Record<
  SystemApiKeyDef['category'],
  { title: string; hint: string }
> = {
  core: {
    title: 'Essenciais',
    hint: 'CLIs de código, voz principal e automação do Nexus.',
  },
  voice: {
    title: 'Voz',
    hint: 'Ditado e síntese de voz da assistente Jarvis.',
  },
  media: {
    title: 'Estúdio de Mídia',
    hint: 'Geração de imagens e vídeos.',
  },
  models: {
    title: 'Modelos extras',
    hint: 'Provedores adicionais de inferência e gateways.',
  },
};

const VOICE_MANAGED_ENV_VARS = new Set([
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
]);

interface KeyCardState {
  hasKey: boolean;
  isEnv: boolean;
  masked: string | null;
}

export function ApiKeysSection() {
  const copy = platformCopy();
  const providers = useProviderStore((s) => s.providers);
  const voiceInfoFromStore = useVoiceStore((s) => s.info);
  const setVoiceInfoStore = useVoiceStore((s) => s.setInfo);

  const [voiceInfo, setVoiceInfo] = useState<VoiceRuntimeInfo | null>(voiceInfoFromStore);
  const [jevStatus, setJevStatus] = useState<JevStatus | null>(null);
  const [mediaList, setMediaList] = useState<MediaProviderInfo[]>([]);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [feedback, setFeedback] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [visiblePassword, setVisiblePassword] = useState<Record<string, boolean>>({});
  const [vaultState, setVaultState] = useState<
    'empty' | 'readable' | 'foreign-or-locked' | 'partial' | null
  >(null);
  const [passphrase, setPassphrase] = useState('');
  const [portabilityMsg, setPortabilityMsg] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const refreshAll = useCallback(async () => {
    try {
      const [freshVoice, freshProviders, freshMedia, freshJev] = await Promise.all([
        window.nexus?.voice?.getInfo?.().catch(() => null),
        window.nexus?.providers?.list?.().catch(() => []),
        window.nexus?.media?.listProviders?.().catch(() => []),
        window.nexus?.jev?.status?.().catch(() => null),
      ]);
      if (freshVoice) {
        setVoiceInfo(freshVoice);
        setVoiceInfoStore(freshVoice);
      }
      if (Array.isArray(freshProviders)) {
        useProviderStore.getState().receive(freshProviders);
      }
      if (Array.isArray(freshMedia)) {
        setMediaList(freshMedia);
      }
      if (freshJev) {
        setJevStatus(freshJev);
      }
    } catch {
      // best effort refresh
    }
  }, [setVoiceInfoStore]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const resolveKeyState = useCallback(
    (def: SystemApiKeyDef): KeyCardState => {
      // 1. Voice key inspection
      const voiceKey = voiceInfo?.keys.find((k: VoiceApiKeyStatus) => k.envVar === def.envVar);
      // 2. Provider inspection
      const provider = def.adapterId ? providers.find((p) => p.adapterId === def.adapterId) : null;
      // 3. Media inspection
      const media = def.mediaProviderIds
        ? mediaList.find((m) => def.mediaProviderIds?.includes(m.id))
        : null;
      // 4. TypeSafe/Jev vault (status próprio, sem adapter de provider)
      const jev = def.envVar === 'TYPESAFE_API_KEY' ? jevStatus : null;

      const hasStoredKey = Boolean(
        voiceKey?.hasStoredKey ||
        provider?.hasKey ||
        media?.hasKey ||
        jev?.hasStoredKey,
      );

      const isEnv = Boolean(
        voiceKey?.hasEnv ||
        jev?.hasEnv ||
        (provider?.keyEnvVar && !hasStoredKey && provider.hasKey),
      );

      const masked =
        voiceKey?.keyMasked ||
        provider?.keyMasked ||
        media?.maskedKey ||
        jev?.keyMasked ||
        null;

      return {
        hasKey: hasStoredKey || isEnv,
        isEnv,
        masked: hasStoredKey || isEnv ? masked ?? '••••' : null,
      };
    },
    [voiceInfo, providers, mediaList, jevStatus],
  );

  async function handleSaveKey(def: SystemApiKeyDef, rawValue: string) {
    if (busyId) return;
    const value = rawValue.trim();
    setBusyId(def.id);
    setFeedback(null);
    try {
      const tasks: Promise<unknown>[] = [];

      // Salva no cofre de voz se for uma chave reconhecida pela Jarvis/Voz
      if (VOICE_MANAGED_ENV_VARS.has(def.envVar) && window.nexus?.voice?.setKey) {
        tasks.push(window.nexus.voice.setKey({ envVar: def.envVar, key: value }));
      }

      // Salva no cofre do Jev (TypeSafe) — vault próprio, fora dos adapters
      if (def.envVar === 'TYPESAFE_API_KEY' && window.nexus?.jev?.setKey) {
        tasks.push(window.nexus.jev.setKey({ key: value }));
      }

      // Salva no cofre de providers se houver adaptador CLI/API correspondente
      if (def.adapterId && window.nexus?.providers?.setKey) {
        tasks.push(window.nexus.providers.setKey({ adapterId: def.adapterId, key: value }));
      }

      // Salva no cofre de mídia se houver provedor de mídia correspondente
      if (def.mediaProviderIds && window.nexus?.media?.setKey) {
        for (const mId of def.mediaProviderIds) {
          tasks.push(window.nexus.media.setKey(mId, value));
        }
      }

      await Promise.all(tasks);
      await refreshAll();

      setDrafts((prev) => ({ ...prev, [def.id]: '' }));
      setFeedback({
        id: def.id,
        ok: true,
        message: value ? `Chave salva com sucesso no ${copy.vault}.` : 'Chave removida.',
      });
    } catch (err) {
      setFeedback({
        id: def.id,
        ok: false,
        message: err instanceof Error ? err.message : 'Não foi possível salvar a chave.',
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleTestKey(def: SystemApiKeyDef) {
    const isJev = def.envVar === 'TYPESAFE_API_KEY';
    if ((!isJev && !def.adapterId) || busyId) return;
    if (isJev ? !window.nexus?.jev?.test : !window.nexus?.providers?.testKey) return;
    setBusyId(`test-${def.id}`);
    setTestResult((prev) => ({ ...prev, [def.id]: { ok: true, message: 'Testando conexão…' } }));
    try {
      const result = isJev
        ? await window.nexus.jev.test()
        : await window.nexus.providers.testKey(def.adapterId!);
      setTestResult((prev) => ({
        ...prev,
        [def.id]: {
          ok: result.ok,
          message: result.detail,
        },
      }));
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [def.id]: {
          ok: false,
          message: err instanceof Error ? err.message : 'Falha no teste',
        },
      }));
    } finally {
      setBusyId(null);
    }
  }

  const filteredKeys = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SYSTEM_API_KEYS;
    return SYSTEM_API_KEYS.filter(
      (k) =>
        k.title.toLowerCase().includes(q) ||
        k.envVar.toLowerCase().includes(q) ||
        k.description.toLowerCase().includes(q) ||
        k.id.toLowerCase().includes(q),
    );
  }, [query]);

  const configuredCount = useMemo(() => {
    return SYSTEM_API_KEYS.filter((k) => resolveKeyState(k).hasKey).length;
  }, [resolveKeyState]);

  const renderKeyCard = (def: SystemApiKeyDef) => {
    const state = resolveKeyState(def);
    const draft = drafts[def.id] ?? '';
    const isBusy = busyId === def.id || busyId === `test-${def.id}`;
    const isTesting = busyId === `test-${def.id}`;
    const itemFeedback = feedback?.id === def.id ? feedback : null;
    const itemTestResult = testResult[def.id] ?? null;
    const showPassword = visiblePassword[def.id] ?? false;
    const credLink = credentialLinkForEnv(def.envVar) ?? {
      label: def.docLabel,
      url: def.docLink,
    };

    return (
      <article
        key={def.id}
        className="api-key-card"
        data-state={state.isEnv ? 'env' : state.hasKey ? 'saved' : 'missing'}
        role="listitem"
        aria-label={`Chave de ${def.title}`}
      >
        <header className="api-key-card__head">
          <div className="api-key-card__title-row">
            <div className="api-key-card__brand">
              <ProviderLogo adapterId={def.logoId} label={def.title} size="sm" />
              <div>
                <h3 className="api-key-card__name">{def.title}</h3>
                <code className="api-key-card__env">{def.envVar}</code>
              </div>
            </div>
            <div className="api-key-card__status-badge">
              {state.isEnv ? (
                <span
                  className="settings-chip api-key-card__chip api-key-card__chip--env"
                  title="Lida da variável de ambiente do sistema"
                >
                  <span className="api-key-card__dot" aria-hidden />
                  process.env
                </span>
              ) : state.hasKey ? (
                <span className="settings-chip settings-chip--ok api-key-card__chip">
                  <span className="api-key-card__dot" data-tone="ok" aria-hidden />
                  Salva no {copy.vault}
                </span>
              ) : (
                <span className="settings-chip api-key-card__chip api-key-card__chip--dim">
                  Não configurada
                </span>
              )}
            </div>
          </div>
          <p className="api-key-card__desc">{def.description}</p>
        </header>

        <div className="api-key-card__body">
          <div className="api-key-card__input-wrapper">
            <input
              className="settings-input api-key-card__input"
              type={showPassword ? 'text' : 'password'}
              aria-label={`Chave de API de ${def.title}`}
              placeholder={
                state.hasKey
                  ? `Configurada (${state.masked ?? '••••'}). Cole nova para alterar`
                  : def.placeholder || 'Cole sua chave de acesso aqui'
              }
              value={draft}
              onChange={(e) =>
                setDrafts((prev) => ({ ...prev, [def.id]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim() && !isBusy) {
                  void handleSaveKey(def, draft);
                }
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={isBusy}
            />
            <button
              type="button"
              className="api-key-card__visibility-toggle"
              title={showPassword ? 'Ocultar chave' : 'Mostrar chave digitada'}
              aria-label={showPassword ? 'Ocultar chave digitada' : 'Mostrar chave digitada'}
              aria-pressed={showPassword}
              onClick={() =>
                setVisiblePassword((prev) => ({ ...prev, [def.id]: !showPassword }))
              }
            >
              <PixelIcon name={showPassword ? 'close' : 'vision'} size={12} />
            </button>
          </div>

          <div className="api-key-card__actions">
            <div className="api-key-card__action-buttons">
              <button
                type="button"
                className="settings-btn settings-btn--primary settings-btn--sm"
                onClick={() => void handleSaveKey(def, draft)}
                disabled={isBusy || !draft.trim()}
              >
                {busyId === def.id ? 'Salvando…' : 'Salvar chave'}
              </button>

              {state.hasKey && (
                <button
                  type="button"
                  className="settings-btn settings-btn--danger settings-btn--sm"
                  onClick={() => void handleSaveKey(def, '')}
                  disabled={isBusy}
                >
                  Remover
                </button>
              )}

              {(def.adapterId || def.envVar === 'TYPESAFE_API_KEY') && state.hasKey && (
                <button
                  type="button"
                  className="settings-btn settings-btn--sm"
                  onClick={() => void handleTestKey(def)}
                  disabled={isBusy}
                >
                  {isTesting ? 'Testando…' : 'Testar conexão'}
                </button>
              )}
            </div>

            <a
              className="settings-link api-key-card__get-link"
              href={credLink.url}
              onClick={(e) => openExternalFromAnchor(e, credLink.url)}
              target="_blank"
              rel="noreferrer"
            >
              Obter em {credLink.label} ↗
            </a>
          </div>

          {itemFeedback && (
            <p
              className={`api-key-card__feedback ${
                itemFeedback.ok ? 'api-key-card__feedback--ok' : 'api-key-card__feedback--err'
              }`}
              role={itemFeedback.ok ? 'status' : 'alert'}
            >
              <PixelIcon name={itemFeedback.ok ? 'check' : 'warn'} size={12} />
              <span>{itemFeedback.message}</span>
            </p>
          )}

          {itemTestResult && (
            <p
              className={`api-key-card__feedback ${
                itemTestResult.ok
                  ? 'api-key-card__feedback--ok'
                  : 'api-key-card__feedback--err'
              }`}
              role={itemTestResult.ok ? 'status' : 'alert'}
            >
              <PixelIcon name={itemTestResult.ok ? 'check' : 'warn'} size={12} />
              <span>{itemTestResult.message}</span>
            </p>
          )}
        </div>
      </article>
    );
  };

  return (
    <section className="settings-section api-keys-section">
      <header className="api-keys-section__header">
        <div>
          <SettingsSectionTitle>Chaves de API</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Gerencie e configure em um só lugar as chaves dos provedores de IA usados no NexusIDE
            (Gemini, Grok, Groq, OpenAI, Claude e outros). Salvas de forma segura, cifradas pelo {copy.vault}.
          </p>
        </div>
        <div className="api-keys-section__stats">
          <span className="settings-chip settings-chip--ok">
            <PixelIcon name="check" size={10} />
            {configuredCount} de {SYSTEM_API_KEYS.length} configuradas
          </span>
          <span className="settings-chip" title={`Armazenamento cifrado pelo ${copy.vaultDetail}`}>
            <PixelIcon name="key" size={12} /> {copy.vaultChip}
          </span>
        </div>
      </header>

      <DecisionModelsSection />

      <div className="api-keys-section__filter-row">
        <input
          type="search"
          className="settings-input api-keys-section__search"
          placeholder="Filtrar por serviço (ex.: gemini, grok, groq, claude, openai)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filtrar chaves de API"
        />
        {query && (
          <button
            type="button"
            className="settings-btn settings-btn--sm"
            onClick={() => setQuery('')}
          >
            Limpar filtro
          </button>
        )}
      </div>

      {filteredKeys.length === 0 ? (
        <EmptyState
          icon="search"
          title="Nenhum serviço encontrado"
          body={`Nada corresponde a “${query.trim()}”. Limpe o filtro para ver todos os provedores.`}
          action={
            <button
              type="button"
              className="settings-btn"
              onClick={() => setQuery('')}
            >
              Limpar filtro
            </button>
          }
        />
      ) : (
        CATEGORY_ORDER.map((category) => {
          const items = filteredKeys.filter((k) => k.category === category);
          if (items.length === 0) return null;
          const meta = CATEGORY_META[category];
          return (
            <section
              key={category}
              className="api-keys-group"
              aria-label={meta.title}
            >
              <header className="api-keys-group__head">
                <h3 className="api-keys-group__title">{meta.title}</h3>
                <p className="api-keys-group__hint">{meta.hint}</p>
              </header>
              <div className="api-keys-section__grid" role="list">
                {items.map(renderKeyCard)}
              </div>
            </section>
          );
        })
      )}

      <section className="api-keys-group" aria-label="Multi-PC">
        <header className="api-keys-group__head">
          <h3 className="api-keys-group__title">Multi-PC</h3>
          <p className="api-keys-group__hint">
            O cofre de keys é cifrado pelo {copy.vault} de cada máquina. Para levar as
            keys para outra máquina: exporte aqui com uma passphrase, importe lá.
            {copy.vaultCaution ? ` ${copy.vaultCaution}` : null}
          </p>
        </header>
        {vaultState === 'foreign-or-locked' && (
          <p className="settings-detail__hint" role="status">
            Este cofre parece vir de outra máquina — os blobs não abrem neste
            {' '}{copy.vault}. Importe o export (ou re-insira as keys); nada foi perdido
            na máquina de origem.
          </p>
        )}
        <div className="api-keys-section__filter-row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input
            type="password"
            autoComplete="new-password"
            className="settings-input api-keys-section__search"
            placeholder="Passphrase (mín. 8 caracteres)"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-label="Passphrase do pacote de keys"
            style={{ maxWidth: 240 }}
          />
          <button
            type="button"
            className="settings-btn settings-btn--sm"
            disabled={busyId === 'export-keys' || passphrase.trim().length < 8}
            onClick={async () => {
              if (busyId) return;
              setBusyId('export-keys');
              setPortabilityMsg(null);
              try {
                const result = await window.nexus.providers.exportSecrets(passphrase);
                if (result.ok) {
                  setPortabilityMsg({
                    ok: true,
                    message: `Exportado ${result.exportedKeys} key(s) → ${result.path ?? 'arquivo'}. Guarde o arquivo e a passphrase; apague o arquivo depois de importar.${
                      result.skippedKeys?.length
                        ? ` (${result.skippedKeys.length} key(s) ilegível(eis) nesta máquina foram puladas.)`
                        : ''
                    }`,
                  });
                } else {
                  setPortabilityMsg({ ok: false, message: result.error ?? 'Export falhou.' });
                }
              } catch (err) {
                setPortabilityMsg({
                  ok: false,
                  message: err instanceof Error ? err.message : 'Export falhou.',
                });
              } finally {
                setBusyId(null);
              }
            }}
          >
            {busyId === 'export-keys' ? 'Exportando…' : 'Exportar keys'}
          </button>
          <input
            type="file"
            accept=".nexusvault,application/json"
            aria-label="Arquivo .nexusvault para importar"
            className="settings-input"
            style={{ maxWidth: 260 }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file || busyId) return;
              if (passphrase.trim().length < 8) {
                setPortabilityMsg({
                  ok: false,
                  message: 'Informe a passphrase antes de importar.',
                });
                return;
              }
              setBusyId('import-keys');
              setPortabilityMsg(null);
              try {
                const bundle = await file.text();
                const result = await window.nexus.providers.importSecrets(bundle, passphrase);
                if (result.ok) {
                  setPortabilityMsg({
                    ok: true,
                    message: `Importado ${result.importedKeys} key(s).${
                      result.failedKeys?.length
                        ? ` Recusadas nesta máquina: ${result.failedKeys.join(', ')}.`
                        : ''
                    }`,
                  });
                  await refreshAll();
                  setVaultState(await window.nexus.providers.vaultState());
                } else {
                  setPortabilityMsg({ ok: false, message: result.error ?? 'Import falhou.' });
                }
              } catch (err) {
                setPortabilityMsg({
                  ok: false,
                  message: err instanceof Error ? err.message : 'Import falhou.',
                });
              } finally {
                setBusyId(null);
              }
            }}
          />
          <button
            type="button"
            className="settings-btn settings-btn--sm"
            onClick={async () => {
              try {
                setVaultState(await window.nexus.providers.vaultState());
              } catch {
                setVaultState(null);
              }
            }}
          >
            Verificar cofre
          </button>
        </div>
        {portabilityMsg && (
          <p
            className="settings-detail__hint"
            role="status"
            style={portabilityMsg.ok ? undefined : { color: 'var(--danger, #c44)' }}
          >
            {portabilityMsg.message}
          </p>
        )}
      </section>
    </section>
  );
}

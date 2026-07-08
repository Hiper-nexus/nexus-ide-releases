import { useState } from 'react';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { credentialLinkForKeySlot } from '../../../shared/credential-links';
import { useProviderStore } from '../../state/provider-store';
import { openExternalFromAnchor } from '../../lib/open-external';
import { AccountsManager } from './AccountsManager';

/**
 * Providers/CLIs + Keys hub — the central place to enable/disable each CLI,
 * override its binary path, default model and extra args, route a
 * Claude-compatible CLI to another upstream (ai-launcher port), and store its
 * API key SECURELY (macOS Keychain via safeStorage — the key never returns to
 * the UI, only a masked preview).
 */

function modelLabel(provider: ProviderSettingsInfo, model: string): string {
  const info = provider.modelInfo?.[model];
  const tags = [
    provider.customModels.includes(model) ? 'custom' : null,
    info?.availability ?? null,
    info?.costTier && info.costTier !== 'unknown' ? `cost:${info.costTier}` : null,
  ].filter(Boolean);
  return tags.length > 0 ? `${model} (${tags.join(', ')})` : model;
}

function providerRiskWarning(provider: ProviderSettingsInfo): string | null {
  const risky = provider.models.filter((model) => {
    const availability = provider.modelInfo?.[model]?.availability;
    return availability === 'api-only' || availability === 'deprecated';
  });
  if (risky.length === 0) return null;
  return `Modelos bloqueados no roteamento automático: ${risky.slice(0, 3).join(', ')}. Ainda podem ser escolhidos manualmente.`;
}

function KeyField({ provider }: { provider: ProviderSettingsInfo }) {
  const setKey = useProviderStore((s) => s.setKey);
  const testKey = useProviderStore((s) => s.testKey);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const credentialLink = credentialLinkForKeySlot({
    envVar: provider.keyEnvVar,
    providerId: provider.adapterId,
    upstreamId: provider.routable ? provider.upstream : null,
  });

  async function save() {
    setBusy(true);
    const result = await setKey(provider.adapterId, draft);
    setBusy(false);
    setDraft('');
    setStatus(result.ok ? 'key salva no Keychain' : result.error ?? 'falhou');
  }

  async function clear() {
    setBusy(true);
    await setKey(provider.adapterId, '');
    setBusy(false);
    setStatus('key removida');
  }

  async function test() {
    setBusy(true);
    setStatus('testando…');
    const result = await testKey(provider.adapterId);
    setBusy(false);
    setStatus(`${result.ok ? '✓' : '✗'} ${result.detail}`);
  }

  return (
    <div className="prov__key">
      <div className="prov__key-row">
        <span className="prov__key-label">
          API key
          {provider.keyEnvVar && (
            <code className="prov__env"> → {provider.keyEnvVar}</code>
          )}
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
        <span
          className={`settings-chip ${provider.hasKey ? 'settings-chip--ok' : 'settings-chip--warn'}`}
        >
          {provider.hasKey ? provider.keyMasked ?? 'set' : 'sem key'}
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
        <button
          className="settings-btn"
          onClick={() => void test()}
          disabled={busy}
        >
          Testar
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
      {!provider.secureStorageAvailable && (
        <p className="prov__warn">
          ⚠ Keychain indisponível nesta máquina — a key não será persistida em
          disco (só nesta sessão). Nunca gravamos em plaintext.
        </p>
      )}
      {status && <p className="prov__status">{status}</p>}
    </div>
  );
}

/**
 * Add any model the provider offers that we didn't bundle (e.g. a brand-new
 * "glm-5.2" or "gpt-5.6"). Custom models appear everywhere the adapter's models
 * do — provider default, Modo Livre picker, squad roster.
 */
function CustomModels({ provider }: { provider: ProviderSettingsInfo }) {
  const addModel = useProviderStore((s) => s.addModel);
  const removeModel = useProviderStore((s) => s.removeModel);
  const [draft, setDraft] = useState('');

  function add() {
    const clean = draft.trim();
    if (!clean) return;
    void addModel(provider.adapterId, clean);
    setDraft('');
  }

  return (
    <>
      Adicionar modelo (qualquer id que a LLM ofertar)
      <div className="prov__models-add">
        <input
          className="settings-input"
          value={draft}
          placeholder="ex.: glm-5.2, gpt-5.6, claude-sonnet-5…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="settings-btn" onClick={add} disabled={!draft.trim()}>
          + Adicionar
        </button>
      </div>
      {provider.customModels.length > 0 && (
        <div className="prov__models-chips">
          {provider.customModels.map((m) => (
            <span key={m} className="prov__model-chip">
              {m}
              <button
                className="prov__model-chip-x"
                onClick={() => void removeModel(provider.adapterId, m)}
                title="Remover"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

const PERMISSION_LABEL: Record<string, string> = {
  default: 'Default',
  auto: 'Auto',
  plan: 'Plan',
  bypass: 'Bypass',
  yolo: 'YOLO',
  untrusted: 'Untrusted',
};

/**
 * Auto-operation controls per CLI: permission mode (turn on bypass/yolo so the
 * agent runs without asking), reasoning effort and verbose. Only the options
 * the adapter actually declares are shown, so no CLI gets a flag it can't
 * parse. "CLI default" = leave it to the CLI (no flag).
 */
function ControlFlags({
  provider,
  patch,
}: {
  provider: ProviderSettingsInfo;
  patch: (p: Partial<Parameters<ReturnType<typeof useProviderStore.getState>['setConfig']>[0]>) => void;
}) {
  const hasPerm = provider.permissionModes.length > 0;
  const hasEffort = provider.efforts.length > 0;
  if (!hasPerm && !hasEffort && !provider.supportsVerbose) return null;

  return (
    <div className="prov__control">
      {hasPerm && (
        <div className="prov__ctl-row">
          <span className="prov__ctl-label" title="Como o agente pede permissão. YOLO/Bypass = roda sozinho sem perguntar.">
            Permissão
          </span>
          <div className="prov__ctl-btns">
            <button
              className={`prov__ctl-btn ${provider.permissionMode === '' ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ permissionMode: '' })}
            >
              CLI default
            </button>
            {provider.permissionModes.map((m) => (
              <button
                key={m}
                className={`prov__ctl-btn ${provider.permissionMode === m ? 'prov__ctl-btn--on' : ''} ${m === 'yolo' || m === 'bypass' ? 'prov__ctl-btn--danger' : ''}`}
                onClick={() => patch({ permissionMode: m })}
              >
                {PERMISSION_LABEL[m] ?? m}
              </button>
            ))}
          </div>
        </div>
      )}
      {hasEffort && (
        <div className="prov__ctl-row">
          <span className="prov__ctl-label">Effort</span>
          <div className="prov__ctl-btns">
            <button
              className={`prov__ctl-btn ${provider.effort === '' ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ effort: '' })}
            >
              CLI default
            </button>
            {provider.efforts.map((e) => (
              <button
                key={e}
                className={`prov__ctl-btn ${provider.effort === e ? 'prov__ctl-btn--on' : ''}`}
                onClick={() => patch({ effort: e })}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
      {provider.supportsVerbose && (
        <div className="prov__ctl-row">
          <span className="prov__ctl-label">Verbose</span>
          <div className="prov__ctl-btns">
            <button
              className={`prov__ctl-btn ${!provider.verbose ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ verbose: false })}
            >
              Off
            </button>
            <button
              className={`prov__ctl-btn ${provider.verbose ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ verbose: true })}
            >
              On
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderSettingsInfo }) {
  const setConfig = useProviderStore((s) => s.setConfig);
  const [binDraft, setBinDraft] = useState(provider.binPath);
  const [argsDraft, setArgsDraft] = useState(provider.extraArgs.join(' '));
  const riskWarning = providerRiskWarning(provider);

  const patch = (p: Partial<Parameters<typeof setConfig>[0]>) =>
    void setConfig({ adapterId: provider.adapterId, ...p });

  return (
    <li className={`prov ${provider.enabled ? '' : 'prov--off'}`}>
      <div className="prov__head">
        <span className="prov__title">
          {provider.icon} {provider.label}
        </span>
        <span
          className={`settings-chip ${provider.installed ? 'settings-chip--ok' : 'settings-chip--warn'}`}
        >
          {provider.installed ? 'detectado' : 'ausente'}
        </span>
        <span
          className={`settings-chip ${
            provider.authStrategy === 'subscription'
              ? 'settings-chip--ok'
              : provider.authStrategy === 'api-key'
                ? ''
                : 'settings-chip--warn'
          }`}
          title="Prioridade: assinatura (OAuth/plano). API key é só fallback."
        >
          {provider.authStrategy === 'subscription'
            ? 'assinatura'
            : provider.authStrategy === 'api-key'
              ? 'via API key'
              : 'login pendente'}
        </span>
        <label className="prov__toggle" title="Habilitar/desabilitar">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>{provider.enabled ? 'on' : 'off'}</span>
        </label>
      </div>

      <div className="prov__grid">
        <label className="prov__field">
          Binário (vazio = <code>{provider.detectedBin}</code>)
          <input
            className="settings-input"
            value={binDraft}
            placeholder={provider.detectedBin}
            onChange={(e) => setBinDraft(e.target.value)}
            onBlur={() => patch({ binPath: binDraft })}
          />
        </label>

        <label className="prov__field">
          Modelo padrão
          <select
            className="settings-input"
            value={provider.defaultModel}
            onChange={(e) => patch({ defaultModel: e.target.value })}
          >
            {provider.models.map((m) => (
              <option key={m} value={m}>
                {modelLabel(provider, m)}
              </option>
            ))}
          </select>
          {provider.modelInfo?.[provider.defaultModel]?.warning && (
            <span className="prov__hint">
              {provider.modelInfo[provider.defaultModel].warning}
            </span>
          )}
        </label>

        <div className="prov__field prov__field--wide">
          <CustomModels provider={provider} />
        </div>

        <label className="prov__field prov__field--wide">
          Args extras
          <input
            className="settings-input"
            value={argsDraft}
            placeholder="ex.: --verbose --foo bar"
            onChange={(e) => setArgsDraft(e.target.value)}
            onBlur={() =>
              patch({
                extraArgs: argsDraft.split(/\s+/).filter(Boolean),
              })
            }
          />
        </label>

        {provider.routable && (
          <label className="prov__field prov__field--wide">
            Upstream (roteamento ai-launcher)
            <select
              className="settings-input"
              value={provider.upstream}
              onChange={(e) => patch({ upstream: e.target.value })}
            >
              {provider.upstreams.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                  {u.requiresToken ? ' (requer key)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ControlFlags provider={provider} patch={patch} />

      <KeyField provider={provider} />

      <AccountsManager adapterId={provider.adapterId} />

      {provider.loginHint && (
        <p className="prov__hint">{provider.loginHint}</p>
      )}
      {riskWarning && <p className="prov__warn">{riskWarning}</p>}
    </li>
  );
}

export function ProvidersPanel() {
  const providers = useProviderStore((s) => s.providers);
  return (
    <section>
      <h3 className="settings-detail__title">Providers / CLIs</h3>
      <p className="settings-detail__hint">
        Habilite/desabilite cada CLI, ajuste binário, modelo e args, roteie CLIs
        Claude-compatíveis para outro upstream (GLM, Fugu, DeepSeek…) e guarde
        as keys no Keychain do macOS. Nada de key em plaintext.
      </p>
      <ul className="prov__list">
        {providers.map((p) => (
          <ProviderCard key={p.adapterId} provider={p} />
        ))}
      </ul>
    </section>
  );
}

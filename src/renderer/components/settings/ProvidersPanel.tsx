import { useState } from 'react';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { useProviderStore } from '../../state/provider-store';

/**
 * Providers/CLIs + Keys hub — the central place to enable/disable each CLI,
 * override its binary path, default model and extra args, route a
 * Claude-compatible CLI to another upstream (ai-launcher port), and store its
 * API key SECURELY (macOS Keychain via safeStorage — the key never returns to
 * the UI, only a masked preview).
 */

function KeyField({ provider }: { provider: ProviderSettingsInfo }) {
  const setKey = useProviderStore((s) => s.setKey);
  const testKey = useProviderStore((s) => s.testKey);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

function ProviderCard({ provider }: { provider: ProviderSettingsInfo }) {
  const setConfig = useProviderStore((s) => s.setConfig);
  const [binDraft, setBinDraft] = useState(provider.binPath);
  const [argsDraft, setArgsDraft] = useState(provider.extraArgs.join(' '));

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
                {m}
              </option>
            ))}
          </select>
        </label>

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

      <KeyField provider={provider} />

      {provider.loginHint && (
        <p className="prov__hint">{provider.loginHint}</p>
      )}
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

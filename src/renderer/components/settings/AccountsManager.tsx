import { useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import { useAccountStore } from '../../state/account-store';

/**
 * Multi-account manager for one adapter — the failover roster. Add a Claude
 * subscription account (snapshots the active login) or an API-key account
 * (native, or routed to GLM/z.ai · Sakana Fugu · DeepSeek). The active account
 * is used at spawn; when it hits a limit, the engine switches to the next.
 */

const UPSTREAMS = [
  { id: 'anthropic', label: 'Anthropic (key nativa)' },
  { id: 'glm', label: 'GLM / z.ai' },
  { id: 'sakana', label: 'Sakana Fugu' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'openrouter', label: 'OpenRouter' },
];

function cooldownLabel(a: AccountInfo): string {
  if (!a.onCooldown || !a.cooldownUntil) return '';
  const mins = Math.max(1, Math.round((a.cooldownUntil - Date.now()) / 60000));
  return mins >= 60 ? `~${Math.round(mins / 60)}h` : `${mins}min`;
}

export function AccountsManager({ adapterId }: { adapterId: string }) {
  const accounts = useAccountStore((s) =>
    s.accounts.filter((a) => a.adapterId === adapterId),
  );
  const add = useAccountStore((s) => s.add);
  const addActiveClaude = useAccountStore((s) => s.addActiveClaude);
  const rename = useAccountStore((s) => s.rename);
  const remove = useAccountStore((s) => s.remove);
  const activate = useAccountStore((s) => s.activate);

  const [label, setLabel] = useState('');
  const [upstream, setUpstream] = useState('anthropic');
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function addApiKey() {
    if (!label.trim() || !key.trim()) return;
    setBusy(true);
    const res = await add({
      adapterId,
      label: label.trim(),
      mode: 'api-key',
      upstream,
      key: key.trim(),
    });
    setBusy(false);
    if (res.ok) {
      setLabel('');
      setKey('');
      setNotice('Conta adicionada.');
    } else {
      setNotice(res.error ?? 'Falhou.');
    }
  }

  async function snapshotClaude() {
    const name = label.trim() || 'Conta Claude';
    setBusy(true);
    const res = await addActiveClaude(name);
    setBusy(false);
    setNotice(
      res.ok
        ? `Sessão Claude salva${res.email ? ` (${res.email})` : ''}.`
        : res.error ?? 'Falhou.',
    );
    if (res.ok) setLabel('');
  }

  const isClaude = adapterId === 'claude';

  return (
    <div className="acct">
      <div className="acct__head">
        <span className="acct__title">Contas &amp; failover</span>
        <span className="acct__hint">
          A conta ativa é usada ao abrir; ao esgotar, o app troca sozinho para a
          próxima e retoma com --resume.
        </span>
      </div>

      {accounts.length > 0 && (
        <ul className="acct__list">
          {accounts.map((a) => (
            <li key={a.id} className={`acct__item ${a.active ? 'acct__item--active' : ''}`}>
              <button
                className="acct__radio"
                onClick={() => void activate(a.id)}
                title={a.active ? 'Conta ativa' : 'Ativar esta conta'}
              >
                {a.active ? '◉' : '○'}
              </button>
              <div className="acct__meta">
                <span className="acct__name">{a.label}</span>
                <span className="acct__tags">
                  <span className="acct__badge">
                    {a.mode === 'subscription'
                      ? 'assinatura'
                      : a.upstream === 'anthropic'
                        ? 'api key'
                        : a.upstream}
                  </span>
                  {a.email && <span className="acct__email">{a.email}</span>}
                  {a.onCooldown && (
                    <span className="acct__cooldown" title={a.lastError}>
                      cooldown {cooldownLabel(a)}
                    </span>
                  )}
                  {!a.hasCredential && (
                    <span className="acct__warn">sem credencial</span>
                  )}
                </span>
              </div>
              <button
                className="acct__mini"
                onClick={() => {
                  const name = prompt('Novo nome da conta:', a.label);
                  if (name && name.trim()) void rename(a.id, name.trim());
                }}
                title="Renomear"
              >
                ✎
              </button>
              <button
                className="acct__mini acct__mini--danger"
                onClick={() => void remove(a.id)}
                title="Remover"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="acct__add">
        <input
          className="settings-input"
          value={label}
          placeholder="nome da conta (ex.: trabalho, pessoal, z.ai)"
          onChange={(e) => setLabel(e.target.value)}
        />
        {isClaude && (
          <button
            className="settings-btn"
            onClick={() => void snapshotClaude()}
            disabled={busy}
            title="Salva a sessão Claude atualmente logada no Keychain"
          >
            + Assinatura (sessão logada)
          </button>
        )}
      </div>
      <div className="acct__add">
        {isClaude && (
          <select
            className="settings-input settings-input--narrow"
            value={upstream}
            onChange={(e) => setUpstream(e.target.value)}
          >
            {UPSTREAMS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        )}
        <input
          className="settings-input"
          type="password"
          value={key}
          placeholder="API key (para conta por key / GLM / Fugu…)"
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          className="settings-btn settings-btn--primary"
          onClick={() => void addApiKey()}
          disabled={busy || !label.trim() || !key.trim()}
        >
          + Conta por key
        </button>
      </div>
      {notice && <p className="acct__notice">{notice}</p>}
    </div>
  );
}

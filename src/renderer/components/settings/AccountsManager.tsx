import { useEffect, useMemo, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import { useAccountStore } from '../../state/account-store';

/**
 * Multi-account manager for one adapter — the failover roster. O topo SEMPRE
 * responde "qual conta está em uso AGORA" (inclusive a implícita: a sessão
 * nativa do CLI quando nenhuma conta foi adicionada). Adição por revelação
 * progressiva: dois botões claros → formulário compacto correspondente.
 */

const UPSTREAMS = [
  { id: 'anthropic', label: 'Anthropic (key nativa)' },
  { id: 'mimo', label: 'MIMO / Xiaomi' },
  { id: 'glm', label: 'GLM / z.ai' },
  { id: 'moonshot', label: 'Kimi / Moonshot' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'qwen', label: 'Qwen / Alibaba' },
  { id: 'sakana', label: 'Sakana Fugu' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'longcat', label: 'LongCat (Meituan)' },
];

function cooldownLabel(a: AccountInfo): string {
  if (!a.onCooldown || !a.cooldownUntil) return '';
  const mins = Math.max(1, Math.round((a.cooldownUntil - Date.now()) / 60000));
  return mins >= 60 ? `~${Math.round(mins / 60)}h` : `${mins}min`;
}

function accountKindLabel(a: AccountInfo): string {
  if (a.mode === 'subscription') return 'assinatura';
  if (!a.upstream || a.upstream === 'anthropic') return 'API key';
  return UPSTREAMS.find((u) => u.id === a.upstream)?.label ?? a.upstream;
}

export function AccountsManager({ adapterId }: { adapterId: string }) {
  // Select the whole array (stable reference) and filter in a memo — a
  // selector that returns `.filter(...)` makes a NEW array every render, which
  // sends zustand's useSyncExternalStore into an infinite loop (white screen).
  const allAccounts = useAccountStore((s) => s.accounts);
  const accounts = useMemo(
    () => allAccounts.filter((a) => a.adapterId === adapterId),
    [allAccounts, adapterId],
  );
  const add = useAccountStore((s) => s.add);
  const addActiveClaude = useAccountStore((s) => s.addActiveClaude);
  const rename = useAccountStore((s) => s.rename);
  const remove = useAccountStore((s) => s.remove);
  const activate = useAccountStore((s) => s.activate);
  const hydrate = useAccountStore((s) => s.hydrate);

  const [addMode, setAddMode] = useState<null | 'subscription' | 'api-key'>(null);
  const [label, setLabel] = useState('');
  const [upstream, setUpstream] = useState('anthropic');
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [auth, setAuth] = useState<{ state: string; detail: string } | null>({
    state: 'checking',
    detail: 'Verificando a sessão desta CLI…',
  });

  async function refreshAuth() {
    const list = await window.nexus.providers.authStatus();
    const mine = list.find((s) => s.adapterId === adapterId);
    setAuth(mine ? { state: mine.state, detail: mine.detail } : null);
  }

  useEffect(() => {
    let alive = true;
    void window.nexus.providers.authStatus().then((list) => {
      if (!alive) return;
      const mine = list.find((s) => s.adapterId === adapterId);
      setAuth(mine ? { state: mine.state, detail: mine.detail } : null);
    });
    return () => {
      alive = false;
    };
  }, [adapterId]);
  const [busy, setBusy] = useState(false);

  const isClaude = adapterId === 'claude';
  const active = accounts.find((a) => a.active) ?? null;

  function closeForm() {
    setAddMode(null);
    setLabel('');
    setKey('');
    setNotice(null);
  }

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
    await hydrate();
    await refreshAuth();
    setBusy(false);
    if (res.ok) {
      closeForm();
      setNotice('Conta adicionada, ativada e pronta para o próximo terminal.');
    } else {
      setNotice(res.error ?? 'Falhou.');
    }
  }

  async function snapshotClaude() {
    const name = label.trim() || 'Conta Claude';
    setBusy(true);
    const res = await addActiveClaude(name);
    await hydrate();
    await refreshAuth();
    setBusy(false);
    if (res.ok) {
      closeForm();
      setNotice(
        `Sessão Claude salva, ativada e sincronizada${res.email ? ` (${res.email})` : ''}.`,
      );
    } else {
      setNotice(res.error ?? 'Falhou.');
    }
  }

  async function useAccount(id: string) {
    setBusy(true);
    const res = await activate(id);
    await hydrate();
    await refreshAuth();
    setBusy(false);
    setNotice(
      res.ok
        ? 'Conta ativada e sincronizada para o próximo terminal.'
        : res.error ?? 'Não consegui ativar essa conta.',
    );
  }

  async function removeAccount(id: string) {
    setBusy(true);
    await remove(id);
    await hydrate();
    await refreshAuth();
    setBusy(false);
    setNotice('Conta removida.');
  }

  const authClass =
    auth?.state === 'ok'
      ? 'acct__status acct__status--ok'
      : auth?.state === 'missing'
        ? 'acct__status acct__status--missing'
        : 'acct__status';

  const standby = accounts.filter((a) => !a.active);

  return (
    <div className="acct">
      <div className="acct__head">
        <div>
          <span className="acct__title">Contas deste provider</span>
          <p className="acct__hint">
            Veja qual sessão será usada no próximo terminal e configure contas
            reserva para troca automática quando houver limite.
          </p>
        </div>
        {auth && (
          <span
            className={authClass}
            title={auth.detail}
          >
            {auth.state === 'ok'
              ? 'Login verificado'
              : auth.state === 'missing'
                ? 'Login necessário'
                : auth.state === 'checking'
                  ? 'Verificando login…'
                  : 'Não foi possível verificar'}
          </span>
        )}
      </div>
      {auth?.detail && <p className="acct__auth-detail">{auth.detail}</p>}

      <div className="acct__section">
        <span className="acct__section-label">Em uso no próximo terminal</span>
        <div className="acct__inuse">
          <span className="acct__inuse-pill">ATIVA</span>
          {active ? (
            <>
              <span className="acct__inuse-name">{active.label}</span>
              <span className="acct__badge">{accountKindLabel(active)}</span>
              {active.email && <span className="acct__email">{active.email}</span>}
              <button
                className="acct__use"
                onClick={() => void useAccount(active.id)}
                disabled={busy}
                title="Reaplicar esta conta no ambiente da CLI"
              >
                sincronizar
              </button>
              <button
                className="acct__mini"
                onClick={() => {
                  const name = prompt('Novo nome da conta:', active.label);
                  if (name && name.trim()) void rename(active.id, name.trim());
                }}
                title="Renomear conta ativa"
              >
                ✎
              </button>
              <button
                className="acct__mini acct__mini--danger"
                onClick={() => void removeAccount(active.id)}
                title="Remover conta ativa"
                disabled={busy}
              >
                ✕
              </button>
            </>
          ) : (
            <span className="acct__inuse-name acct__inuse-name--implicit">
              sessão nativa do {adapterId}
              <span className="acct__email"> · login do terminal (sem conta salva)</span>
            </span>
          )}
        </div>
      </div>

      <div className="acct__section">
        <span className="acct__section-label">
          Contas reserva{standby.length > 0 ? ` (${standby.length})` : ''}
        </span>
        {standby.length === 0 ? (
          <p className="acct__empty">
            Nenhuma conta reserva. Adicione outra para failover automático.
          </p>
        ) : (
          <ul className="acct__list">
            {standby.map((a) => (
              <li key={a.id} className="acct__item">
                <div className="acct__meta">
                  <span className="acct__name">{a.label}</span>
                  <span className="acct__tags">
                    <span className="acct__badge">{accountKindLabel(a)}</span>
                    {a.email && <span className="acct__email">{a.email}</span>}
                    {a.onCooldown && (
                      <span className="acct__cooldown" title={a.lastError}>
                        esgotada · volta em {cooldownLabel(a)}
                      </span>
                    )}
                    {!a.hasCredential && (
                      <span className="acct__warn">sem credencial</span>
                    )}
                  </span>
                </div>
                <button
                  className="acct__use"
                  onClick={() => void useAccount(a.id)}
                  disabled={busy}
                  title="Tornar esta a conta em uso"
                >
                  usar
                </button>
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
                  onClick={() => void removeAccount(a.id)}
                  title="Remover"
                  disabled={busy}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="acct__section">
        <span className="acct__section-label">Adicionar conta</span>
      {addMode === null && (
        <div className="acct__add-choices">
          {isClaude && (
            <button
              className="settings-btn"
              onClick={() => setAddMode('subscription')}
              title="Salva a sessão Claude atualmente logada (Keychain)"
            >
              ＋ Por assinatura (Claude logado)
            </button>
          )}
          <button
            className="settings-btn"
            onClick={() => setAddMode('api-key')}
            title="Conta com API key (nativa ou roteada: GLM, LongCat, OpenRouter…)"
          >
            ＋ Por API key
          </button>
        </div>
      )}

      {addMode === 'subscription' && (
        <div className="acct__form">
          <p className="acct__form-title">
            Salvar a <strong>sessão logada</strong> do claude como uma conta
            (troque de login no terminal para adicionar outras).
          </p>
          <div className="acct__add">
            <input
              className="settings-input"
              value={label}
              placeholder="nome (ex.: trabalho, pessoal)"
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
            />
            <button
              className="settings-btn settings-btn--primary"
              onClick={() => void snapshotClaude()}
              disabled={busy}
            >
              Salvar sessão
            </button>
            <button className="settings-btn" onClick={closeForm}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {addMode === 'api-key' && (
        <div className="acct__form">
          <p className="acct__form-title">
            Conta por <strong>API key</strong> — nativa ou roteada (GLM,
            LongCat, OpenRouter…). A key vai para o Keychain.
          </p>
          <div className="acct__add">
            <input
              className="settings-input"
              value={label}
              placeholder="nome (ex.: z.ai, longcat)"
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
            />
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
          </div>
          <div className="acct__add">
            <input
              className="settings-input"
              type="password"
              value={key}
              placeholder="cole a API key"
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              className="settings-btn settings-btn--primary"
              onClick={() => void addApiKey()}
              disabled={busy || !label.trim() || !key.trim()}
            >
              Adicionar
            </button>
            <button className="settings-btn" onClick={closeForm}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {notice && <p className="acct__notice">{notice}</p>}
      </div>
    </div>
  );
}

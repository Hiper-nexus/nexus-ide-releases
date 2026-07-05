import { useMemo, useState } from 'react';
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

  const [addMode, setAddMode] = useState<null | 'subscription' | 'api-key'>(null);
  const [label, setLabel] = useState('');
  const [upstream, setUpstream] = useState('anthropic');
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
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
    setBusy(false);
    if (res.ok) {
      closeForm();
      setNotice('Conta adicionada — ela entra na fila de failover.');
    } else {
      setNotice(res.error ?? 'Falhou.');
    }
  }

  async function snapshotClaude() {
    const name = label.trim() || 'Conta Claude';
    setBusy(true);
    const res = await addActiveClaude(name);
    setBusy(false);
    if (res.ok) {
      closeForm();
      setNotice(`Sessão Claude salva${res.email ? ` (${res.email})` : ''}.`);
    } else {
      setNotice(res.error ?? 'Falhou.');
    }
  }

  return (
    <div className="acct">
      <div className="acct__head">
        <span className="acct__title">Contas &amp; failover</span>
      </div>

      {/* Quem está em uso AGORA — sempre visível, inclusive a conta implícita. */}
      <div className="acct__inuse">
        <span className="acct__inuse-pill">EM USO</span>
        {active ? (
          <>
            <span className="acct__inuse-name">{active.label}</span>
            <span className="acct__badge">{accountKindLabel(active)}</span>
            {active.email && <span className="acct__email">{active.email}</span>}
          </>
        ) : (
          <span className="acct__inuse-name acct__inuse-name--implicit">
            sessão nativa do {adapterId}
            <span className="acct__email"> · o login do seu terminal</span>
          </span>
        )}
      </div>
      <p className="acct__hint">
        Ao esgotar créditos/limite, o app troca sozinho para a próxima conta da
        lista e retoma a conversa com --resume.
      </p>

      {accounts.length > 0 && (
        <ul className="acct__list">
          {accounts.map((a) => (
            <li
              key={a.id}
              className={`acct__item ${a.active ? 'acct__item--active' : ''}`}
            >
              <div className="acct__meta">
                <span className="acct__name">
                  {a.label}
                  {a.active && <span className="acct__inuse-pill acct__inuse-pill--sm">EM USO</span>}
                </span>
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
              {!a.active && (
                <button
                  className="acct__use"
                  onClick={() => void activate(a.id)}
                  title="Tornar esta a conta em uso"
                >
                  usar
                </button>
              )}
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

      {/* Adição por revelação progressiva: escolha clara, depois o form. */}
      {addMode === null && (
        <div className="acct__add-choices">
          {isClaude && (
            <button
              className="settings-btn"
              onClick={() => setAddMode('subscription')}
              title="Salva a sessão Claude atualmente logada (Keychain)"
            >
              ＋ Conta por assinatura
            </button>
          )}
          <button
            className="settings-btn"
            onClick={() => setAddMode('api-key')}
            title="Conta com API key (nativa ou roteada: GLM, LongCat, OpenRouter…)"
          >
            ＋ Conta por API key
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
  );
}

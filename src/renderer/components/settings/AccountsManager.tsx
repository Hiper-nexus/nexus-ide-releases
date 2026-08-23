import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import { accountLoginCommandFor } from '../../../shared/account-login-commands';
import { useAccountStore } from '../../state/account-store';
import { useUsageStore } from '../../state/usage-store';
import { askConfirm } from '../../state/confirm-store';
import { PixelIcon } from '../PixelIcon';
import { openCliLoginTerminal } from './cli-login-terminal';
import {
  apiKeyChoiceBlurb,
  multiAccountAddCopy,
  sessionChoiceBlurb,
} from './multi-account-copy';

/**
 * Multi-account manager for one adapter — the failover roster.
 * Always answers "which account runs on the next terminal", including the
 * implicit native CLI session when nothing is vaulted yet.
 * Mesma UX para todas as CLIs (Claude, Codex, AGY, Grok, Kimi, OpenCode,
 * GLM, LongCat, Aider): só muda o label e se snapshot OAuth está disponível.
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

function accountState(a: AccountInfo): 'active' | 'cooldown' | 'warn' | 'ready' {
  if (a.active) return 'active';
  if (a.onCooldown) return 'cooldown';
  if (!a.hasCredential) return 'warn';
  return 'ready';
}

function authStatusLabel(state: string | undefined): string {
  if (state === 'ok') return 'conectado';
  if (state === 'missing') return 'precisa login';
  if (state === 'checking') return 'verificando…';
  return 'não verificado';
}

function formatAccountUsd(costUsd: number): string {
  return `US$ ${costUsd.toFixed(2).replace('.', ',')}`;
}

export function AccountsManager({
  adapterId,
  adapterLabel,
}: {
  adapterId: string;
  /** Nome legível do provider (Claude, AGY…). Fallback = adapterId. */
  adapterLabel?: string;
}) {
  // Select the whole array (stable reference) and filter in a memo — a
  // selector that returns `.filter(...)` makes a NEW array every render, which
  // sends zustand's useSyncExternalStore into an infinite loop (white screen).
  const allAccounts = useAccountStore((s) => s.accounts);
  const accounts = useMemo(
    () => allAccounts.filter((a) => a.adapterId === adapterId),
    [allAccounts, adapterId],
  );
  const add = useAccountStore((s) => s.add);
  const addActiveSession = useAccountStore((s) => s.addActiveSession);
  const supportsSnapshot = useAccountStore((s) => s.supportsSnapshot);
  const rename = useAccountStore((s) => s.rename);
  const remove = useAccountStore((s) => s.remove);
  const activate = useAccountStore((s) => s.activate);
  const hydrate = useAccountStore((s) => s.hydrate);
  const usageByAccount = useUsageStore((s) => s.snapshot.byAccount);

  const [addMode, setAddMode] = useState<null | 'subscription' | 'api-key'>(null);
  const [label, setLabel] = useState('');
  const [upstream, setUpstream] = useState('anthropic');
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<'ok' | 'err' | 'info'>('info');
  const [auth, setAuth] = useState<{ state: string; detail: string } | null>({
    state: 'checking',
    detail: 'Verificando a sessão desta CLI…',
  });
  const [busy, setBusy] = useState(false);
  const [canSnapshot, setCanSnapshot] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const isClaude = adapterId === 'claude';
  const active = accounts.find((a) => a.active) ?? null;
  const standby = accounts.filter((a) => !a.active);
  const loginCommand = accountLoginCommandFor(adapterId);

  /**
   * Disparado por `onFinished` do terminal de login — um evento EXTERNO que
   * pode chegar depois que a pessoa saiu de Configurações (ou, em teste,
   * depois do teardown). Sem a guarda, virava rejection não tratada.
   */
  async function refreshAuth() {
    try {
      const list = await window.nexus?.providers?.authStatus();
      if (!list) return;
      const mine = list.find((s) => s.adapterId === adapterId);
      setAuth(mine ? { state: mine.state, detail: mine.detail } : null);
    } catch {
      // Refresh de fundo: falhar aqui não pode derrubar a tela nem gritar.
    }
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

  useEffect(() => {
    let alive = true;
    void supportsSnapshot(adapterId).then((ok) => {
      if (alive) setCanSnapshot(ok);
    });
    return () => {
      alive = false;
    };
  }, [adapterId, supportsSnapshot]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  function closeForm() {
    setAddMode(null);
    setLabel('');
    setKey('');
  }

  function showNotice(message: string, tone: 'ok' | 'err' | 'info' = 'info') {
    setNotice(message);
    setNoticeTone(tone);
  }

  function startRename(account: AccountInfo) {
    setRenamingId(account.id);
    setRenameDraft(account.label);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }

  async function commitRename() {
    if (!renamingId) return;
    const next = renameDraft.trim();
    if (!next) {
      cancelRename();
      return;
    }
    setBusy(true);
    await rename(renamingId, next);
    await hydrate();
    setBusy(false);
    cancelRename();
    showNotice('Nome atualizado.', 'ok');
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
      showNotice('Conta adicionada e ativada para o próximo terminal.', 'ok');
    } else {
      showNotice(res.error ?? 'Não foi possível adicionar a conta.', 'err');
    }
  }

  async function snapshotSession() {
    const name = label.trim() || `Conta ${adapterId}`;
    setBusy(true);
    const res = await addActiveSession(adapterId, name);
    await hydrate();
    await refreshAuth();
    setBusy(false);
    if (res.ok) {
      closeForm();
      showNotice(
        `Sessão salva e ativada${res.email ? ` · ${res.email}` : ''}. Reinicie panes abertos para aplicar.`,
        'ok',
      );
    } else {
      showNotice(res.error ?? 'Não foi possível salvar a sessão logada.', 'err');
    }
  }

  /**
   * Mesmo caminho do painel de CLIs: abre um terminal real, roda o comando da
   * ferramenta e reexamina o login quando aquele terminal fecha.
   */
  async function openLoginTerminal() {
    if (!loginCommand) return;
    setBusy(true);
    const result = await openCliLoginTerminal({
      command: loginCommand,
      onFinished: () => {
        void refreshAuth();
        void hydrate();
      },
    });
    setBusy(false);
    if (result.ok) {
      showNotice(
        'Terminal aberto. Conclua o login lá. Quando fechar, o Nexus verifica sozinho.',
        'info',
      );
    } else {
      showNotice(result.error, 'err');
    }
  }

  async function useAccount(id: string) {
    setBusy(true);
    const res = await activate(id);
    await hydrate();
    await refreshAuth();
    setBusy(false);
    showNotice(
      res.ok
        ? 'Conta ativada. Próximo terminal usa esta sessão.'
        : (res.error ?? 'Não consegui ativar essa conta.'),
      res.ok ? 'ok' : 'err',
    );
  }

  async function removeAccount(account: AccountInfo) {
    const ok = await askConfirm({
      title: `Remover “${account.label}”?`,
      body: account.active
        ? 'Esta é a conta ativa. O próximo terminal volta à sessão nativa da CLI até você ativar outra.'
        : 'A conta sai do vault de failover. Credenciais salvas neste perfil deixam de ser usadas.',
      confirmLabel: 'Remover conta',
      cancelLabel: 'Manter',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    await remove(account.id);
    await hydrate();
    await refreshAuth();
    setBusy(false);
    if (renamingId === account.id) cancelRename();
    showNotice('Conta removida.', 'info');
  }

  const authClass =
    auth?.state === 'ok'
      ? 'acct__status acct__status--ok'
      : auth?.state === 'missing'
        ? 'acct__status acct__status--missing'
        : auth?.state === 'checking'
          ? 'acct__status acct__status--checking'
          : 'acct__status';

  function renderRow(account: AccountInfo, role: 'active' | 'standby') {
    const state = accountState(account);
    const isRenaming = renamingId === account.id;
    const realUsage = usageByAccount[account.id];

    return (
      <li
        key={account.id}
        className={`acct__row ${role === 'active' ? 'acct__row--active' : ''}`}
        data-state={state}
      >
        <span
          className="acct__led"
          data-state={state}
          aria-hidden="true"
        />
        <div className="acct__body">
          {isRenaming ? (
            <div className="acct__rename">
              <input
                ref={renameInputRef}
                className="settings-input acct__rename-input"
                value={renameDraft}
                aria-label="Novo nome da conta"
                disabled={busy}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename();
                  if (e.key === 'Escape') cancelRename();
                }}
              />
              <button
                type="button"
                className="settings-btn settings-btn--primary acct__action"
                disabled={busy || !renameDraft.trim()}
                onClick={() => void commitRename()}
              >
                Salvar nome
              </button>
              <button
                type="button"
                className="settings-btn acct__action"
                disabled={busy}
                onClick={cancelRename}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <>
              <div className="acct__identity">
                <span className="acct__name">{account.label}</span>
                {role === 'active' && (
                  <span className="acct__pill">Em uso</span>
                )}
                <span className="acct__badge">{accountKindLabel(account)}</span>
              </div>
              <div className="acct__meta-line">
                {account.email && (
                  <span className="acct__email">{account.email}</span>
                )}
                {account.onCooldown && (
                  <span className="acct__cooldown" title={account.lastError}>
                    esgotada · volta em {cooldownLabel(account)}
                  </span>
                )}
                {!account.hasCredential && (
                  <span className="acct__warn">sem credencial</span>
                )}
                {role === 'active' && !account.onCooldown && account.hasCredential && (
                  <span className="acct__meta-quiet">próximo terminal</span>
                )}
                {realUsage && (
                  <span
                    className="acct__usage"
                    title={`${realUsage.inputTokens + realUsage.outputTokens} tokens atribuídos por transcript`}
                  >
                    {formatAccountUsd(realUsage.costUsd)} · {realUsage.turns}{' '}
                    {realUsage.turns === 1 ? 'turno real' : 'turnos reais'}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        {!isRenaming && (
          <div className="acct__actions">
            {role === 'active' ? (
              <button
                type="button"
                className="settings-btn acct__action"
                onClick={() => void useAccount(account.id)}
                disabled={busy}
                title="Reaplicar esta conta no ambiente da CLI"
              >
                Sincronizar
              </button>
            ) : (
              <button
                type="button"
                className="settings-btn settings-btn--primary acct__action"
                onClick={() => void useAccount(account.id)}
                disabled={busy || account.onCooldown || !account.hasCredential}
                title={
                  account.onCooldown
                    ? 'Em cooldown — indisponível até o limite passar'
                    : !account.hasCredential
                      ? 'Sem credencial salva'
                      : 'Tornar esta a conta em uso'
                }
              >
                Usar
              </button>
            )}
            <button
              type="button"
              className="settings-btn acct__action"
              onClick={() => startRename(account)}
              disabled={busy}
              title="Renomear conta"
            >
              Renomear
            </button>
            <button
              type="button"
              className="settings-btn settings-btn--danger acct__action"
              onClick={() => void removeAccount(account)}
              disabled={busy}
              title="Remover conta do vault"
            >
              Remover
            </button>
          </div>
        )}
      </li>
    );
  }

  const vaultCount = accounts.length;
  const displayName = (adapterLabel?.trim() || adapterId).trim();
  // Em uso já conta como 1ª (vault ativa ou sessão nativa/API key ok).
  const hasEmUso = Boolean(active) || auth?.state === 'ok';
  const addCopy = multiAccountAddCopy({
    vaultCount,
    standbyCount: standby.length,
    hasEmUso,
  });

  return (
    <div className="acct" data-adapter={adapterId}>
      <div className="acct__head">
        <div className="acct__head-copy">
          <div className="acct__title-row">
            <h4 className="acct__title">Contas e login · {displayName}</h4>
            <span
              className={`acct__multi-chip${addCopy.chipOn ? ' acct__multi-chip--on' : ''}`}
              title={addCopy.chipTitle}
            >
              {addCopy.chip}
            </span>
          </div>
          <p className="acct__hint">
            Guarde <strong>várias contas</strong> de {displayName} (trabalho,
            pessoal, API key…). A em uso abre o próximo terminal; as reserva
            entram no failover quando o limite bater. Mesmo fluxo em todas as
            CLIs.
          </p>
        </div>
        {auth && (
          <span className={authClass} title={auth.detail}>
            {authStatusLabel(auth.state)}
          </span>
        )}
      </div>

      {auth?.detail && auth.state !== 'ok' && (
        <p className="acct__auth-detail" role="status">
          {auth.detail}
          {auth.state === 'missing' && loginCommand && (
            <button
              type="button"
              className="settings-btn acct__login-now"
              onClick={() => void openLoginTerminal()}
              disabled={busy}
              title={`Abre um terminal com “${loginCommand}”`}
            >
              Fazer login agora
            </button>
          )}
        </p>
      )}

      <div className="acct__roster">
        <div className="acct__section-head">
          <span className="acct__section-kicker">1 · Em uso</span>
          <span className="acct__section-hint">próximo terminal / pane</span>
        </div>

        {active ? (
          <ul className="acct__list" aria-label="Conta em uso">
            {renderRow(active, 'active')}
          </ul>
        ) : (
          <div className="acct__implicit" data-state={auth?.state === 'ok' ? 'ok' : 'idle'}>
            <span className="acct__led" data-state={auth?.state === 'ok' ? 'ready' : 'idle'} aria-hidden="true" />
            <div className="acct__body">
              <div className="acct__identity">
                <span className="acct__name">Sessão nativa de {displayName}</span>
                <span className="acct__pill acct__pill--quiet">Implícita</span>
              </div>
              <p className="acct__meta-line">
                Login do terminal, ainda sem entrada no vault. Salve esta
                sessão (ou uma API key) abaixo — pode repetir para 2ª, 3ª…
                conta.
              </p>
            </div>
          </div>
        )}

        <div className="acct__section-head">
          <span className="acct__section-kicker">
            2 · Reserva{standby.length > 0 ? ` · ${standby.length}` : ' · vazia'}
          </span>
          <span className="acct__section-hint">
            failover automático no mesmo provider
          </span>
        </div>

        {standby.length === 0 ? (
          <div className="acct__empty acct__empty--cta" role="status">
            <div className="acct__empty-copy">
              <strong>Nenhuma conta reserva ainda</strong>
              <span>
                Adicione a <em>2ª conta</em> (outra assinatura ou API key) para
                hot-swap e troca automática quando a em uso esgotar o limite.
              </span>
            </div>
            <span className="acct__empty-steps" aria-hidden="true">
              <span className="acct__empty-step">1 em uso</span>
              <span className="acct__empty-arrow">→</span>
              <span className="acct__empty-step acct__empty-step--need">+ reserva</span>
            </span>
          </div>
        ) : (
          <ul className="acct__list" aria-label="Contas reserva">
            {standby.map((a) => renderRow(a, 'standby'))}
          </ul>
        )}
      </div>

      <div className="acct__add-zone" data-open={addMode !== null ? 'true' : 'false'}>
        <div className="acct__add-head">
          <div className="acct__add-head-copy">
            <span className="acct__section-kicker">3 · {addCopy.title}</span>
            <p className="acct__add-sub">{addCopy.sub}</p>
          </div>
        </div>

        {addMode === null && (
          <div className="acct__add-choices">
            {loginCommand && (
              <button
                type="button"
                className="settings-btn settings-btn--primary acct__add-choice"
                onClick={() => void openLoginTerminal()}
                disabled={busy}
                title={`Abre um terminal com “${loginCommand}” — o navegador abre na página de login do provider`}
              >
                <span className="acct__add-choice-icon" aria-hidden="true">
                  <PixelIcon name="user" size={14} />
                </span>
                <span className="acct__add-choice-text">
                  <strong>Entrar com nova conta</strong>
                  <span>
                    Dispara o login de {displayName} — o navegador abre na
                    página do provider. Depois volte e salve a sessão no vault.
                  </span>
                </span>
                <span className="acct__add-plus" aria-hidden="true">
                  →
                </span>
              </button>
            )}
            {canSnapshot && (
              <button
                type="button"
                className="settings-btn settings-btn--primary acct__add-choice"
                onClick={() => setAddMode('subscription')}
                title={`Salva a sessão OAuth/login atual de ${displayName} como mais uma conta no vault`}
              >
                <span className="acct__add-choice-icon" aria-hidden="true">
                  <PixelIcon name="id-badge" size={14} />
                </span>
                <span className="acct__add-choice-text">
                  <strong>Sessão logada</strong>
                  <span>
                    {sessionChoiceBlurb({
                      adapterLabel: displayName,
                      hasEmUso,
                      vaultCount,
                    })}
                  </span>
                </span>
                <span className="acct__add-plus" aria-hidden="true">
                  +
                </span>
              </button>
            )}
            <button
              type="button"
              className="settings-btn acct__add-choice"
              onClick={() => setAddMode('api-key')}
              title={`Adicionar conta ${displayName} com API key`}
            >
              <span className="acct__add-choice-icon" aria-hidden="true">
                <PixelIcon name="key" size={14} />
              </span>
              <span className="acct__add-choice-text">
                <strong>API key</strong>
                <span>
                  {apiKeyChoiceBlurb({ hasEmUso, vaultCount })}
                </span>
              </span>
              <span className="acct__add-plus" aria-hidden="true">
                +
              </span>
            </button>
          </div>
        )}

        {addMode === 'subscription' && (
          <div className="acct__form" role="group" aria-label="Salvar sessão logada">
            <p className="acct__form-title">
              Nomeie esta conta (ex.: <em>trabalho</em>, <em>pessoal</em>) e
              salve o login atual de <strong>{adapterId}</strong> no vault.
              Depois pode adicionar mais. Panes abertos mantêm a conta antiga
              até reiniciar.
            </p>
            <div className="acct__add">
              <input
                className="settings-input"
                value={label}
                placeholder="nome da conta (ex.: trabalho, pessoal)"
                autoFocus
                aria-label="Nome da conta"
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void snapshotSession();
                  if (e.key === 'Escape') closeForm();
                }}
              />
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                onClick={() => void snapshotSession()}
                disabled={busy}
              >
                Salvar no vault
              </button>
              <button type="button" className="settings-btn" onClick={closeForm} disabled={busy}>
                Cancelar
              </button>
            </div>
          </div>
        )}

        {addMode === 'api-key' && (
          <div className="acct__form" role="group" aria-label="Adicionar API key">
            <p className="acct__form-title">
              Nova entrada no vault com key nativa ou roteada (GLM, LongCat,
              OpenRouter…). Segredo no Keychain; a UI só mostra máscara. Pode
              adicionar várias keys com nomes diferentes.
            </p>
            <div className="acct__add">
              <input
                className="settings-input"
                value={label}
                placeholder="nome da conta (ex.: z.ai, longcat-pessoal)"
                autoFocus
                aria-label="Nome da conta"
                onChange={(e) => setLabel(e.target.value)}
              />
              {isClaude && (
                <select
                  className="settings-input settings-input--narrow"
                  value={upstream}
                  aria-label="Upstream"
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
                aria-label="API key"
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && label.trim() && key.trim() && !busy) {
                    void addApiKey();
                  }
                  if (e.key === 'Escape') closeForm();
                }}
              />
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                onClick={() => void addApiKey()}
                disabled={busy || !label.trim() || !key.trim()}
              >
                Adicionar ao vault
              </button>
              <button type="button" className="settings-btn" onClick={closeForm} disabled={busy}>
                Cancelar
              </button>
            </div>
          </div>
        )}

        {addMode === null && (
          <p className="acct__add-footnote">
            Fluxo típico: salve a sessão atual → mude de conta no CLI ou cole
            outra key → <strong>adicione de novo</strong> como reserva. Quantas
            quiser no mesmo provider.
          </p>
        )}
      </div>

      {notice && (
        <p
          className={`acct__notice acct__notice--${noticeTone}`}
          role={noticeTone === 'err' ? 'alert' : 'status'}
        >
          {notice}
        </p>
      )}
    </div>
  );
}

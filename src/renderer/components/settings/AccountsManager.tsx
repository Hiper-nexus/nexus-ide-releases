import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import type { AdapterAuthStatus } from '../../../shared/provider-settings-types';
import { accountLoginCommandFor } from '../../../shared/account-login-commands';
import { useAccountStore } from '../../state/account-store';
import { useUsageStore } from '../../state/usage-store';
import { askConfirm } from '../../state/confirm-store';
import { defaultAccountLabel, emailFromAuthDetail } from './account-default-label';
import { accountsPanelView } from './accounts-login-view';
import { PixelIcon } from '../PixelIcon';
import { openCliLoginTerminal } from './cli-login-terminal';

/**
 * Multi-account manager for one adapter — the failover roster.
 * Always answers "which account runs on the next terminal", including the
 * implicit native CLI session when nothing is vaulted yet.
 * Mesma UX para todas as CLIs (Claude, Codex, AGY, Grok, Kimi, OpenCode,
 * OpenClaude, GLM, LongCat, Aider): só muda o label e se snapshot OAuth
 * está disponível.
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

function cooldownText(a: AccountInfo): string {
  const time = cooldownLabel(a);
  if (!time) return '';
  const reason = a.lastError?.toLowerCase() ?? '';
  if (/quota|cr[eé]dito|plano|saldo/i.test(reason)) {
    return `cota esgotada · volta em ${time}`;
  }
  return `limite temporário · volta em ${time}`;
}

function accountKindLabel(a: AccountInfo): string {
  if (a.mode === 'subscription') return 'assinatura';
  if (!a.upstream || a.upstream === 'anthropic') return 'API key';
  return UPSTREAMS.find((u) => u.id === a.upstream)?.label ?? a.upstream;
}

function accountState(a: AccountInfo): 'active' | 'cooldown' | 'warn' | 'ready' {
  // Sessão morta vence até o "ativo": o LED tem de acusar antes do próximo
  // spawn queimar um pane num 401 garantido.
  if (a.needsRelogin) return 'warn';
  if (a.active) return 'active';
  if (a.onCooldown) return 'cooldown';
  if (!a.hasCredential) return 'warn';
  return 'ready';
}

function formatAccountUsd(costUsd: number): string {
  return `US$ ${costUsd.toFixed(2).replace('.', ',')}`;
}

export function AccountsManager({
  adapterId,
  adapterLabel,
  authStatus,
  onAuthStatusChange,
  loginCommand: declaredLoginCommand,
}: {
  adapterId: string;
  /** Nome legível do provider (Claude, AGY…). Fallback = adapterId. */
  adapterLabel?: string;
  /** The Providers hub shares one observed state with its list and detail. */
  authStatus?: AdapterAuthStatus | null;
  onAuthStatusChange?: (status: AdapterAuthStatus) => void;
  loginCommand?: string | null;
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
  const [localAuth, setAuth] = useState<{ state: string; detail: string } | null>({
    state: 'checking',
    detail: 'Verificando a sessão desta CLI…',
  });
  const [busy, setBusy] = useState(false);
  const [loginFailed, setLoginFailed] = useState(false);
  const [canSnapshot, setCanSnapshot] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const isClaude = adapterId === 'claude';
  const auth = authStatus === undefined ? localAuth : authStatus ?? {
    state: 'checking', detail: 'Verificando a sessão desta CLI…',
  };
  const displayName = (adapterLabel?.trim() || adapterId).trim();
  const active = accounts.find((a) => a.active) ?? null;
  const standby = accounts.filter((a) => !a.active);
  const loginCommand = declaredLoginCommand === undefined
    ? accountLoginCommandFor(adapterId)
    : declaredLoginCommand;
  // E-mail da sessão viva da CLI (quando a sonda expõe). Identifica QUAL
  // conta está logada no CLI agora — distingue as linhas do vault e alimenta
  // o auto-save pós-login.
  const liveEmail = useMemo(() => {
    if (auth?.state !== 'ok') return null;
    // Identidade em ~/.claude.json sobrevive ao logout. Não pinta
    // "sessão do CLI" / "conectado" com detalhe de sessão morta.
    if (/sem sessão viva|sem OAuth utilizável/i.test(auth.detail)) return null;
    return emailFromAuthDetail(auth.detail);
  }, [auth]);
  const liveEmailNormalized = liveEmail?.trim().toLowerCase() ?? null;
  const vaultHasLiveSession = useMemo(
    () =>
      Boolean(
        liveEmailNormalized &&
          accounts.some(
            (a) => a.email?.trim().toLowerCase() === liveEmailNormalized,
          ),
      ),
    [accounts, liveEmailNormalized],
  );
  const panel = accountsPanelView({
    authState: auth?.state,
    adapterLabel: displayName,
    isClaude,
    vaultCount: accounts.length,
    standbyCount: standby.length,
    hasActiveVault: Boolean(active),
    liveEmail,
    loginCommand,
    canSnapshot,
    busy,
  });

  /**
   * Disparado por `onFinished` do terminal de login — um evento EXTERNO que
   * pode chegar depois que a pessoa saiu de Configurações (ou, em teste,
   * depois do teardown). Sem a guarda, virava rejection não tratada.
   * Devolve o status deste adapter para quem precisa decidir em cima dele.
   */
  async function refreshAuth(): Promise<{
    state: string;
    detail: string;
  } | null> {
    try {
      const list = await window.nexus?.providers?.authStatus();
      if (!list) return null;
      const mine = list.find((s) => s.adapterId === adapterId);
      const next = mine ?? {
        adapterId, state: 'unknown' as const, detail: 'Não foi possível verificar a conexão.',
      };
      setAuth(next);
      onAuthStatusChange?.(next);
      return next;
    } catch {
      const next = { adapterId, state: 'unknown' as const, detail: 'Não foi possível verificar a conexão.' };
      setAuth(next);
      onAuthStatusChange?.(next);
      return null;
    }
  }

  async function verifyAuth() {
    setBusy(true);
    try {
      await refreshAuth();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Auto-save pós-login. O modelo é de duas etapas: o CLI guarda UMA sessão
   * por vez; a conta só existe no Nexus depois de salva. Se o operador loga a
   * 2ª conta antes de salvar a 1ª, o CLI sobrescreve o arquivo e a 1ª some
   * para sempre (o bug "não mostra as duas contas"). Aqui a armadilha fecha
   * sozinha: terminal de login fechou com sessão NOVA (e-mail fora do vault)
   * → a conta entra sem ninguém apertar nada. Best-effort; o caminho manual
   * segue no botão.
   */
  async function autoSaveSessionAfterLogin() {
    try {
      const status = await refreshAuth();
      if (!status || status.state !== 'ok') return;
      const email = emailFromAuthDetail(status.detail);
      if (!email) return; // sonda sem identidade: não há como dedupar
      const known = useAccountStore
        .getState()
        .accounts.find(
          (a) =>
            a.adapterId === adapterId &&
            a.email?.trim().toLowerCase() === email.trim().toLowerCase(),
        );
      if (known && !known.needsRelogin && !known.onCooldown) return;
      const res = await addActiveSession(adapterId, email);
      if (!res.ok) return;
      await hydrate();
      showNotice(
        known
          ? `Conta ${email} reautenticada e pronta no Nexus.`
          : `Conta ${email} salva no Nexus. Troque de conta no CLI e repita para juntar mais.`,
        'ok',
      );
    } catch {
      // Auto-save é conveniência: falha silenciosa, o login já está feito.
    }
  }

  useEffect(() => {
    if (authStatus !== undefined) return;
    let alive = true;
    void window.nexus.providers.authStatus().then(
      (list) => {
        if (!alive) return;
        const mine = list.find((s) => s.adapterId === adapterId);
        setAuth(
          mine
            ? { state: mine.state, detail: mine.detail }
            : {
                state: 'unknown',
                detail: 'Não deu para verificar a sessão desta CLI.',
              },
        );
      },
      () => {
        if (!alive) return;
        setAuth({
          state: 'unknown',
          detail: 'Não deu para verificar a sessão desta CLI.',
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [adapterId, authStatus]);

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
    setLoginFailed(false);
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

  /** Salva a sessão logada da CLI como conta no Nexus (nome já resolvido). */
  async function saveSessionToVault(name: string) {
    setBusy(true);
    const res = await addActiveSession(adapterId, name);
    await hydrate();
    await refreshAuth();
    setBusy(false);
    if (res.ok) {
      closeForm();
      showNotice(
        `Conta salva e ativada${res.email ? ` · ${res.email}` : ''}. Reinicie panes abertos para aplicar.`,
        'ok',
      );
    } else {
      showNotice(res.error ?? 'Não foi possível salvar a sessão logada.', 'err');
    }
  }

  async function snapshotSession() {
    const name = defaultAccountLabel({
      typed: label,
      adapterId,
      adapterLabel: displayName,
      authDetail: auth?.detail,
    });
    await saveSessionToVault(name);
  }

  /**
   * Mesmo caminho do painel de CLIs: abre um terminal real, roda o comando da
   * ferramenta e, quando aquele terminal fecha, o Nexus reexamina o login e
   * salva a conta nova sozinho (auto-save acima).
   */
  async function openLoginTerminal() {
    if (!loginCommand) return;
    setBusy(true);
    showNotice('Abrindo o terminal de login…', 'info');
    try {
      const result = await openCliLoginTerminal({
        command: loginCommand,
        adapterId,
        adapterLabel: displayName,
        onFinished: () => { void autoSaveSessionAfterLogin(); },
      });
      if (result.ok) {
        showNotice('Terminal de login aberto. Siga as instruções da ferramenta.', 'info');
      } else {
        showNotice(result.error, 'err');
        setLoginFailed(true);
      }
    } catch {
      showNotice('Não foi possível abrir o terminal de login.', 'err');
      setLoginFailed(true);
    } finally {
      setBusy(false);
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
        ? active?.id === id
          ? 'Conta sincronizada com a sessão ativa da CLI.'
          : 'Conta ativada. Próximo terminal usa esta sessão.'
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
    // Esta conta É o login vivo da CLI agora (e-mail da sessão bate)? Distinção
    // que faltava: com 2 contas Claude salvas, saber qual está logada no CLI.
    const isLiveCliSession = Boolean(
      liveEmailNormalized &&
        account.email?.trim().toLowerCase() === liveEmailNormalized,
    );

    return (
      <li
        key={account.id}
        className={`acct__row ${role === 'active' && panel.showActiveEmUsoPill ? 'acct__row--active' : ''}`}
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
                {role === 'active' && panel.showActiveEmUsoPill && (
                  <span className="acct__pill">Em uso</span>
                )}
                {isLiveCliSession && (
                  <span
                    className="acct__pill acct__pill--quiet"
                    title="O CLI desta máquina está logado nesta conta agora"
                  >
                    sessão do CLI
                  </span>
                )}
                <span className="acct__badge">{accountKindLabel(account)}</span>
              </div>
              <div className="acct__meta-line">
                {account.email && (
                  <span className="acct__email">{account.email}</span>
                )}
                {account.needsRelogin && (
                  <span
                    className="acct__warn"
                    title={
                      account.lastError
                        ? `Erro: ${account.lastError} — entre novamente`
                        : 'A renovação do token falhou — qualquer terminal novo nesta conta cai em 401'
                    }
                  >
                    sessão expirada — entre novamente
                  </span>
                )}
                {account.onCooldown && !account.needsRelogin && (
                  <span className="acct__cooldown" title={account.lastError}>
                    {cooldownText(account)}
                  </span>
                )}
                {!account.hasCredential && !account.needsRelogin && (
                  <span className="acct__warn">sem credencial</span>
                )}
                {role === 'active' &&
                  panel.showActiveEmUsoPill &&
                  !account.onCooldown &&
                  !account.needsRelogin &&
                  account.hasCredential && (
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
            {account.needsRelogin && loginCommand && (
              <button
                type="button"
                className="settings-btn settings-btn--primary acct__action"
                onClick={() => void openLoginTerminal()}
                disabled={busy}
                title="Abre o terminal de login desta CLI de novo"
              >
                Entrar novamente
              </button>
            )}
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
                disabled={
                  busy ||
                  account.onCooldown ||
                  !account.hasCredential ||
                  account.needsRelogin
                }
                title={
                  account.needsRelogin
                    ? 'Sessão expirada — entre novamente antes de usar'
                    : account.onCooldown
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

  const hasUnsavedSession = panel.showSaveLoggedIn && !vaultHasLiveSession;

  return (
    <div className="acct" data-adapter={adapterId}>
      <div className="acct__head">
        <div className="acct__head-copy">
          <div className="acct__title-row">
            <h4 className="acct__title">Conexão e contas</h4>
          </div>
          <p className="acct__hint">{panel.hint}</p>
        </div>
        {auth && (
          <span className={authClass} title={auth.detail}>
            {panel.statusLabel}
          </span>
        )}
      </div>

      {(panel.showLoginHero || auth?.state === 'unknown') && (
        <div className="acct__login-hero" role="status">
          {auth?.detail && auth.state !== 'unknown' && (
            <p className="acct__login-hero-detail">{auth.detail}</p>
          )}
          <button
            type="button"
            className="settings-btn settings-btn--primary acct__login-cta"
            onClick={() => auth?.state === 'unknown' ? void verifyAuth() : void openLoginTerminal()}
            disabled={busy}
            data-testid="acct-login-cta"
            title={
              loginCommand
                ? `Abre um terminal com “${loginCommand}”`
                : undefined
            }
          >
            {auth?.state === 'unknown' ? (busy ? 'Verificando…' : 'Verificar sessão') : panel.loginCta}
          </button>
          {auth?.state === 'unknown' && loginCommand && (
            <button type="button" className="settings-btn" disabled={busy} onClick={() => void openLoginTerminal()}>
              Abrir login da CLI
            </button>
          )}
        </div>
      )}

      {(panel.showImplicitNative ||
        panel.showSplitRoster ||
        panel.showFlatSavedRoster) && (
        <div className="acct__roster">
          {panel.showImplicitNative && (
            <div
              className="acct__implicit"
              data-state="ok"
            >
              <span
                className="acct__led"
                data-state="ready"
                aria-hidden="true"
              />
              <div className="acct__body">
                <div className="acct__identity">
                  <span className="acct__name">
                    {liveEmail ?? `Sessão nativa de ${displayName}`}
                  </span>
                  <span className="acct__pill">Em uso</span>
                </div>
                <p className="acct__meta-line">
                  Sessão nativa de {displayName} nesta máquina.
                </p>
              </div>
            </div>
          )}

          {panel.showFlatSavedRoster && (
            <>
              <div className="acct__section-head">
                <span className="acct__section-title">Contas salvas</span>
              </div>
              <ul className="acct__list" aria-label="Contas salvas">
                {accounts.map((account) =>
                  renderRow(account, account.active ? 'active' : 'standby'),
                )}
              </ul>
            </>
          )}

          {panel.showSplitRoster && active && (
            <>
              <div className="acct__section-head">
                <span className="acct__section-title">Em uso</span>
                <span className="acct__section-hint">próximo terminal</span>
              </div>
              <ul className="acct__list" aria-label="Conta em uso">
                {renderRow(active, 'active')}
              </ul>
            </>
          )}

          {panel.showReserva && (
            <>
              <div className="acct__section-head">
                <span className="acct__section-title">
                  Reserva
                  {standby.length > 0 ? ` · ${standby.length}` : ''}
                </span>
              </div>
              {standby.length === 0 && panel.showReservaEmpty ? (
                <div className="acct__empty" role="status">
                  Nenhuma reserva. Entre com outra conta ou cole uma API key
                  para o failover.
                </div>
              ) : (
                <ul className="acct__list" aria-label="Contas reserva">
                  {standby.map((account) => renderRow(account, 'standby'))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <div className="acct__add-zone" data-open={addMode !== null ? 'true' : 'false'}>
        {addMode === null && (
          <>
            {hasUnsavedSession && (
              <p className="acct__add-sub">
                Esta sessão ainda não está salva no Nexus. Salve antes de trocar de conta.
              </p>
            )}
            <div className="acct__connection-actions">
              {hasUnsavedSession && (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={busy}
                  onClick={() => liveEmail
                    ? void saveSessionToVault(liveEmail)
                    : setAddMode('subscription')}
                >
                  Salvar esta conta
                </button>
              )}
              {panel.showAddAnotherLogin && (
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void openLoginTerminal()}
                  disabled={busy}
                >
                  {panel.loginCta}
                </button>
              )}
              <button
                type="button"
                className="settings-btn"
                onClick={() => setAddMode('api-key')}
                disabled={busy}
              >
                <PixelIcon name="key" size={12} /> Adicionar API key
              </button>
            </div>
          </>
        )}

        {addMode === 'subscription' && (
          <div className="acct__form" role="group" aria-label="Salvar conta logada">
            <p className="acct__form-title">
              Nomeie esta conta (ex.: <em>trabalho</em>, <em>pessoal</em>) e
              salve o login atual de <strong>{displayName}</strong> no Nexus.
              Sem nome, o e-mail da sessão vira o nome. Depois troque de conta
              no CLI e repita para juntar mais.
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
                Salvar no Nexus
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
              Nova conta com key nativa ou roteada (GLM, LongCat,
              OpenRouter…). O segredo fica criptografado no cofre do Nexus; a
              UI só mostra máscara. Pode adicionar várias keys com nomes
              diferentes.
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
                Adicionar ao Nexus
              </button>
              <button type="button" className="settings-btn" onClick={closeForm} disabled={busy}>
                Cancelar
              </button>
            </div>
          </div>
        )}

      </div>

      {notice && (
        <div
          className={`acct__notice acct__notice--${noticeTone}`}
          role={noticeTone === 'err' ? 'alert' : 'status'}
        >
          <span>{notice}</span>
          {loginFailed && (
            <button
              type="button"
              className="settings-btn"
              onClick={() => void openLoginTerminal()}
              disabled={busy}
            >
              Tentar abrir novamente
            </button>
          )}
        </div>
      )}
    </div>
  );
}

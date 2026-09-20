import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import type { AdapterAuthStatus } from '../../../shared/provider-settings-types';
import { accountLoginCommandFor } from '../../../shared/account-login-commands';
import { useAccountStore } from '../../state/account-store';
import { useUsageStore } from '../../state/usage-store';
import { askConfirm } from '../../state/confirm-store';
import { defaultAccountLabel, emailFromAuthDetail } from './account-default-label';
import { ADD_ACCOUNT_CTA, accountsPanelView } from './accounts-login-view';
import { PixelIcon } from '../PixelIcon';
import { openCliLoginTerminal, type CliLoginFinish } from './cli-login-terminal';
import { useToastStore } from '../../state/toast-store';
import type { ProviderOpPhase } from './providers-panel-view';

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
  { id: 'glm-flash', label: 'GLM Flash / z.ai' },
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
  onAccountAdded,
  onLoginActivity,
  compact = false,
}: {
  adapterId: string;
  /** Nome legível do provider (Claude, AGY…). Fallback = adapterId. */
  adapterLabel?: string;
  /** The Providers hub shares one observed state with its list and detail. */
  authStatus?: AdapterAuthStatus | null;
  onAuthStatusChange?: (status: AdapterAuthStatus) => void;
  loginCommand?: string | null;
  /** Hub de CLIs: LED da lista + banner do detalhe enquanto o login corre. */
  onLoginActivity?: (phase: ProviderOpPhase, error?: string) => void;
  /**
   * Conta recém-cadastrada, pelo `id` que o motor devolveu. Quem embute este
   * painel (o menu "+ Pane") usa o id para levar a escolha até o modelo — sem
   * procurar pelo nome, que numa conta sem e-mail nem sequer é único.
   */
  onAccountAdded?: (accountId: string) => void;
  /** Densidade reduzida para quando o painel vive dentro de um menu. */
  compact?: boolean;
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

  const [addMode, setAddMode] = useState<
    null | 'subscription' | 'api-key' | 'login'
  >(null);
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
  async function refreshAuth(): Promise<AdapterAuthStatus | null> {
    try {
      const list = await window.nexus?.providers?.authStatus();
      if (!list) return null;
      const mine = list.find((s) => s.adapterId === adapterId);
      const next = mine ?? {
        adapterId, state: 'unknown' as const, detail: 'Não foi possível verificar a conexão.',
      };
      setAuth(next);
      onAuthStatusChange?.(next);
      // Devolve a LINHA da sonda, com o sessionFingerprint intacto: é ele que
      // vira o baseline do login e prova que a sessão mudou.
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
   * A conta que já está logada na CLI, guardada ANTES de qualquer troca.
   *
   * O modelo da ferramenta é de uma sessão por vez: quem entra na 2ª conta
   * sem guardar a 1ª perde a 1ª para sempre — o CLI sobrescreve o arquivo.
   * Era o bug "não mostra as duas contas". Guardar é idempotente: o motor
   * deduplica pelo subject/blob e, quando reconhece a mesma conta, atualiza a
   * linha existente sem renomeá-la nem criar uma segunda.
   */
  async function preserveCurrentSession(
    baseline: AdapterAuthStatus | null,
  ): Promise<void> {
    if (!canSnapshot || baseline?.state !== 'ok') return;
    const liveNow = emailFromAuthDetail(baseline.detail)?.trim().toLowerCase();
    // Quando a sonda dá identidade e ela JÁ está no vault, guardar de novo
    // só reescreveria a mesma credencial e pediria restart de pane à toa.
    // Sem identidade não dá para saber, e aí a proteção vence o incômodo: o
    // motor deduplica, então o pior caso é uma reescrita idempotente.
    if (
      liveNow &&
      accounts.some((a) => a.email?.trim().toLowerCase() === liveNow)
    ) {
      return;
    }
    const name = defaultAccountLabel({
      typed: '',
      adapterId,
      adapterLabel: displayName,
      authDetail: baseline.detail,
      taken: accounts.map((a) => a.label),
    });
    try {
      const res = await addActiveSession(adapterId, name);
      if (res.ok) await hydrate();
    } catch {
      // Preservar é rede de proteção: se falhar, o login em si segue valendo.
    }
  }

  /**
   * Fim do terminal de login. O que autoriza gravar uma conta nova é a PROVA
   * que o watcher trouxe (sonda `ok` + sessão diferente do baseline), nunca o
   * simples fechamento do pane: cancelar um login não pode virar conta nova.
   * Sem e-mail também cadastra — o rótulo digitado (ou o padrão) basta, e o
   * `id` devolvido é o que identifica a conta daqui em diante.
   */
  async function saveVerifiedLogin(
    finish: CliLoginFinish,
    typedLabel: string,
  ): Promise<void> {
    try {
      if (finish.status) {
        setAuth(finish.status);
        onAuthStatusChange?.(finish.status);
      } else {
        await refreshAuth();
      }
      await hydrate();
      if (!finish.verified) {
        showNotice(
          `Não deu para confirmar um login novo em ${displayName}. Se você ` +
            'entrou em outra conta, use Salvar esta conta.',
          'info',
        );
        return;
      }
      const name = defaultAccountLabel({
        typed: typedLabel,
        adapterId,
        adapterLabel: displayName,
        // O roster já foi rehidratado acima: um nome genérico não colide com
        // o que a preservação acabou de gravar.
        taken: useAccountStore
          .getState()
          .accounts.filter((a) => a.adapterId === adapterId)
          .map((a) => a.label),
        authDetail: finish.status?.detail,
      });
      const res = await addActiveSession(adapterId, name);
      await hydrate();
      if (!res.ok) {
        showNotice(res.error ?? 'Não foi possível salvar a conta nova.', 'err');
        return;
      }
      showNotice(
        `Conta “${name}” salva no Nexus. Escolha o modelo para abrir um pane ` +
          'nela, ou entre em mais uma conta.',
        'ok',
      );
      if (res.id) onAccountAdded?.(res.id);
    } catch {
      // O login já aconteceu na CLI; falha aqui não pode derrubar a tela.
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
   * Mesmo caminho do painel de CLIs: abre um terminal real e roda o comando da
   * ferramenta. Três coisas acontecem em ordem antes do terminal existir:
   * a sonda é relida (o BASELINE contra o qual o login novo será provado), a
   * conta que está logada agora é guardada, e só então a CLI recebe o comando.
   */
  async function openLoginTerminal(nameHint = '', preserveCurrent = false) {
    if (!loginCommand) return;
    const typedLabel = nameHint.trim();
    setBusy(true);
    showNotice('Abrindo o terminal de login…', 'info');
    onLoginActivity?.('running');
    useToastStore.getState().push('info', `Login ${displayName}`, {
      detail: 'Abrindo o terminal de login…',
      dedupeKey: `cli-login:${adapterId}`,
    });
    try {
      const baseline = await refreshAuth();
      // Só o cadastro de MAIS uma conta preserva a atual. Reentrar numa conta
      // expirada é consertar aquela linha, não trocar de conta: guardar o blob
      // morto antes só sujaria o roster.
      if (preserveCurrent) await preserveCurrentSession(baseline);
      const result = await openCliLoginTerminal({
        command: loginCommand,
        adapterId,
        adapterLabel: displayName,
        baseline,
        onFinished: (finish) => { void saveVerifiedLogin(finish, typedLabel); },
      });
      if (result.ok) {
        closeForm();
        showNotice(
          'Terminal de login aberto. Siga as instruções da ferramenta no pane de login.',
          'info',
        );
        onLoginActivity?.('ok');
        useToastStore.getState().push('success', `Login ${displayName}`, {
          detail: 'Terminal aberto. Continue o login nesse pane — esta tela avisa se a sessão for comprovada.',
          dedupeKey: `cli-login:${adapterId}`,
        });
      } else if (result.cancelled) {
        setNotice(null);
        setLoginFailed(false);
      } else {
        showNotice(result.error, 'err');
        setLoginFailed(true);
        onLoginActivity?.('err', result.error);
        useToastStore.getState().push('error', `Login ${displayName}`, {
          detail: result.error,
          dedupeKey: `cli-login:${adapterId}`,
        });
      }
    } catch (err) {
      console.warn('[cli-login] falha ao abrir o terminal de login:', err);
      showNotice('Não foi possível abrir o terminal de login.', 'err');
      setLoginFailed(true);
      onLoginActivity?.('err', 'Não foi possível abrir o terminal de login.');
      useToastStore.getState().push('error', `Login ${displayName}`, {
        detail: 'Não foi possível abrir o terminal de login.',
        dedupeKey: `cli-login:${adapterId}`,
      });
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
                onClick={() => void openLoginTerminal(account.label)}
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
    <div className="acct" data-adapter={adapterId} data-compact={compact ? 'true' : undefined}>
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

      {notice && (
        <div
          className={`acct__notice acct__notice--${noticeTone}`}
          role={noticeTone === 'err' ? 'alert' : 'status'}
          aria-live="polite"
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
            aria-busy={busy}
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
                  className={
                    hasUnsavedSession
                      ? 'settings-btn'
                      : 'settings-btn settings-btn--primary'
                  }
                  data-testid="acct-add-account"
                  onClick={() => setAddMode('login')}
                  disabled={busy}
                  title={`Cadastra mais uma conta de ${displayName}, sem limite de quantas`}
                >
                  <PixelIcon name="users" size={12} /> {ADD_ACCOUNT_CTA}
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

        {addMode === 'login' && (
          <div className="acct__form" role="group" aria-label="Adicionar conta">
            <p className="acct__form-title">{panel.addAccountHint}</p>
            <div className="acct__add">
              <input
                className="settings-input"
                value={label}
                placeholder="nome da conta (ex.: trabalho, pessoal)"
                autoFocus
                aria-label="Nome da conta nova"
                data-testid="acct-new-name"
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy && loginCommand) {
                    void openLoginTerminal(label, true);
                  }
                  if (e.key === 'Escape') closeForm();
                }}
              />
              {loginCommand && (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  data-testid="acct-add-account-login"
                  onClick={() => void openLoginTerminal(label, true)}
                  disabled={busy}
                  title={`Abre um terminal com “${loginCommand}”`}
                >
                  {panel.loginCta ?? 'Abrir login da CLI'}
                </button>
              )}
              <button
                type="button"
                className="settings-btn"
                onClick={() => setAddMode('api-key')}
                disabled={busy}
              >
                Usar API key
              </button>
              <button type="button" className="settings-btn" onClick={closeForm} disabled={busy}>
                Cancelar
              </button>
            </div>
          </div>
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
    </div>
  );
}

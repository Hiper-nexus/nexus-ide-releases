import { useEffect, useState } from 'react';
import {
  PLANS,
  type PlanDef,
  type PlanId,
  type TeamInfo,
} from '../../../shared/billing-types';
import { useAccess, refreshAccess } from '../../state/access-store';
import { askConfirm } from '../../state/confirm-store';
import { PixelIcon } from '../PixelIcon';
import { AccessAccountCard } from '../access/AccessAccountCard';
import { LicenseCodeForm } from '../access/LicenseCodeForm';
import { accessPrimaryAction } from '../access/access-view';
import { LOGIN_PROVIDERS, loginProviderLabel } from '../../../shared/auth-login';
import { useNexusLogin, waitingProviderOf } from './use-nexus-login';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { accountSessionBadge, isSessionExpiredError } from './account-session-badge';
import { CheckoutChoices, checkoutRequestFrom, DEFAULT_CHECKOUT_CHOICE } from '../billing/CheckoutChoices';

/**
 * Minha Conta — identidade Nexus (login), time e plano.
 * Checkout/portal abrem o browser no site de billing (Stripe); o app nunca
 * vê chaves de pagamento. Contas CLI (Claude/Codex/…) ficam em Providers.
 */

function planPrice(plan: PlanDef): string {
  if (plan.priceMonthlyMinor === 0) return '15 dias';
  const formatted = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: plan.currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(plan.priceMonthlyMinor / 100);
  return `${formatted}/mês`;
}

function planName(id: PlanId): string {
  if (id === 'team') return 'Team (legado)';
  return id === 'free' ? 'Sem acesso ativo' : 'Pro';
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'dono';
  if (role === 'member') return 'membro';
  return role;
}

function AccountHeader() {
  return (
      <header className="account__intro">
        <SettingsSectionTitle>Minha Conta</SettingsSectionTitle>
        <p className="settings-detail__hint account__intro-hint">
          Gerencie sua conta, equipe e assinatura do Nexus. As contas das
          ferramentas de IA ficam em Providers.
        </p>
      </header>
  );
}

export function AccountSection({ accessOnly = false }: { accessOnly?: boolean }) {
  const { license, loading: licenseLoading, failed: licenseFailed, blockedReason } = useAccess();
  const verificationUnavailable = blockedReason === 'verification-unavailable';
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutChoice, setCheckoutChoice] = useState(DEFAULT_CHECKOUT_CHOICE);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemOk, setRedeemOk] = useState(false);
  const [reloginOpen, setReloginOpen] = useState(false);

  const isLoggedIn = Boolean(license?.email);
  // G7 (paridade 1.3.18): verificação de assinatura que falhou NÃO é falta de
  // licença. Com conta presente e verified=false, a tela fala "não confirmado
  // agora" em vez de acusar ausência ou empurrar checkout.
  const licenseUnconfirmed =
    isLoggedIn === true &&
    license?.verified === false &&
    (license.status !== 'none' || license.plan !== 'free');
  useEffect(() => {
    if (!isLoggedIn || accessOnly) {
      setTeam(null);
      setTeamLoading(false);
      return;
    }
    let cancelled = false;
    setTeamLoading(true);
    void window.nexus.team.get().then((result) => {
      if (cancelled) return;
      setTeamLoading(false);
      if (result.ok) setTeam(result.data ?? null);
      else setTeamError(result.error ?? 'Não foi possível carregar o time.');
    }).catch(() => {
      if (cancelled) return;
      setTeamLoading(false);
      setTeamError('Não foi possível carregar sua equipe.');
    });
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, accessOnly]);

  const currentPlan: PlanId = license?.plan ?? 'free';
  const isOwner = team?.team?.role === 'owner';

  const reloadTeam = async () => {
    const result = await window.nexus.team.get();
    if (result.ok) {
      setTeam(result.data ?? null);
      setTeamError(null);
    } else {
      setTeamError(result.error ?? 'Não foi possível atualizar o time.');
    }
  };

  // Abrir o navegador não é login feito: o hook espera o deep link e o conclui
  // (ou mostra por que não deu) em vez de fechar o painel às cegas.
  const login = useNexusLogin({
    onCompleted: async () => {
      await refreshAccess();
      if (!reloginOpen) return;
      setReloginOpen(false);
      setTeamError(null);
      setCheckoutError(null);
      await reloadTeam();
    },
  });

  const joinTeam = async () => {
    const code = joinCode.trim();
    if (!code) {
      setTeamError('Informe o código do convite.');
      return;
    }
    setTeamError(null);
    const result = await window.nexus.team.join(code);
    if (!result.ok) {
      setTeamError(result.error ?? 'Não foi possível entrar no time.');
      return;
    }
    setJoinCode('');
    await reloadTeam();
  };

  const createInvite = async () => {
    setTeamError(null);
    setInviteCopied(false);
    const result = await window.nexus.team.invite();
    if (!result.ok) {
      setTeamError(result.error ?? 'Não foi possível gerar convite.');
      return;
    }
    setInviteUrl(result.data?.url ?? null);
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
    } catch {
      setTeamError('Não foi possível copiar o link. Selecione e copie manualmente.');
    }
  };

  const leaveTeam = async () => {
    const ok = await askConfirm({
      title: 'Sair do time?',
      body: 'Você perde acesso a squads e playbooks compartilhados deste time.',
      confirmLabel: 'Sair do time',
      cancelLabel: 'Ficar',
      danger: true,
    });
    if (!ok) return;
    const result = await window.nexus.team.leave();
    if (!result.ok) {
      setTeamError(result.error ?? 'Não foi possível sair do time.');
      return;
    }
    setTeam(null);
    setInviteUrl(null);
  };

  const removeMember = async (accountId: string, label: string) => {
    const ok = await askConfirm({
      title: `Remover ${label}?`,
      body: 'A pessoa perde acesso ao time e aos recursos compartilhados.',
      confirmLabel: 'Remover membro',
      cancelLabel: 'Manter',
      danger: true,
    });
    if (!ok) return;
    const result = await window.nexus.team.removeMember(accountId);
    if (!result.ok) {
      setTeamError(result.error ?? 'Não foi possível remover o membro.');
      return;
    }
    await reloadTeam();
  };

  const startCheckout = async () => {
    setCheckoutError(null);
    setCheckoutBusy(true);
    try {
      const result = await window.nexus.billing.openCheckout(checkoutRequestFrom(checkoutChoice));
      if (!result.ok) {
        setCheckoutError(result.error ?? 'Não foi possível abrir o checkout.');
      }
    } catch {
      setCheckoutError('Não foi possível abrir o checkout. Tente novamente.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const openPortal = async () => {
    setCheckoutError(null);
    try {
      const result = await window.nexus.billing.openPortal();
      if (!result.ok) setCheckoutError('Não foi possível abrir o portal de cobrança. Tente novamente.');
    } catch {
      setCheckoutError('Não foi possível abrir o portal de cobrança. Tente novamente.');
    }
  };

  // "Tenho um código": o backend valida e devolve a licença assinada; o main
  // aplica e emite billing:changed — aqui basta recontar o acesso.
  const redeemCode = async (code: string) => {
    setRedeemError(null);
    setRedeemBusy(true);
    try {
      const result = await window.nexus.billing.redeemCode(code);
      if (!result.ok) {
        setRedeemError(result.error ?? 'Não foi possível resgatar o código.');
        return;
      }
      setRedeemOk(true);
      await refreshAccess();
    } catch {
      setRedeemError('Não foi possível resgatar o código. Tente novamente.');
    } finally {
      setRedeemBusy(false);
    }
  };

  if (accessOnly) {
    const pro = PLANS.find((plan) => plan.id === 'pro')!;
    const canRetry = licenseFailed || verificationUnavailable;
    return (
      <AccessAccountCard
        email={license?.email ?? null}
        primary={accessPrimaryAction(blockedReason, { isLoggedIn, canRetry })}
        login={login}
        offerTrial={!isLoggedIn}
        proPrice={planPrice(pro)}
        promotion={pro.promotionLabel}
        proFeatures={pro.features.slice(1, 4)}
        checkoutBusy={checkoutBusy}
        canRetry={canRetry}
        retrying={licenseLoading}
        actionError={checkoutError}
        checkoutChoice={checkoutChoice}
        onCheckoutChoice={setCheckoutChoice}
        onCheckout={() => void startCheckout()}
        onPortal={() => void openPortal()}
        onRetry={() => void refreshAccess()}
        canRedeem={isLoggedIn}
        redeemBusy={redeemBusy}
        redeemSucceeded={redeemOk}
        redeemError={redeemError}
        onRedeem={(code) => void redeemCode(code)}
      />
    );
  }

  const sessionBadge = accountSessionBadge({
    loading: licenseLoading,
    isLoggedIn,
    licenseUnconfirmed,
    sessionExpired:
      isSessionExpiredError(teamError) || isSessionExpiredError(checkoutError),
  });
  const showLogin = !licenseLoading && (!isLoggedIn || reloginOpen);
  const waitingProvider = waitingProviderOf(login.phase);

  if (licenseLoading || licenseFailed || verificationUnavailable) {
    return <section className="account" aria-busy={licenseLoading}>
      <AccountHeader />
      <div className="account__load-state" role={licenseFailed || verificationUnavailable ? 'alert' : 'status'}>
        {licenseFailed || verificationUnavailable ? <>
          <h3>Não foi possível carregar sua conta</h3>
          <p>Seu plano não pôde ser consultado agora. Tente novamente para ver os dados da conta.</p>
          <button type="button" className="settings-btn settings-btn--primary" disabled={licenseLoading} onClick={() => void refreshAccess()}>{licenseLoading ? 'Consultando…' : 'Tentar novamente'}</button>
        </> : <><p>Carregando sua conta…</p><div className="settings-skeleton" aria-hidden="true"><span /><span /></div></>}
      </div>
    </section>;
  }

  return (
    <section className="account">
      <AccountHeader />

      <div
        className={`account__identity ${licenseLoading ? 'account__identity--loading' : ''} ${isLoggedIn ? 'account__identity--in' : ''}`}
        role="group"
        aria-label="Identidade da conta"
      >
        <span className="account__avatar" aria-hidden="true">
          <PixelIcon name="user" size={22} />
        </span>
        <div className="account__who">
          <span className="account__email">
            {licenseLoading
              ? 'Carregando conta…'
              : (license?.email ?? 'Conta local (sem login)')}
          </span>
          <div className="account__meta">
            <span
              className={`account__plan-tag${currentPlan !== 'free' ? ' account__plan-tag--paid' : ''}`}
            >
              {license?.access === 'trial' ? 'Teste de 15 dias' : planName(currentPlan)}
            </span>
            <span className="account__status">
              {licenseUnconfirmed
                ? 'Assinatura não confirmada agora'
                : license?.access === 'trial'
                  ? license.trialEndsAt
                    ? `Teste até ${new Date(license.trialEndsAt).toLocaleDateString('pt-BR')}`
                    : 'Teste de 15 dias'
                : license?.status === 'active'
                  ? license.renewsAt
                    ? `Renova em ${new Date(license.renewsAt).toLocaleDateString('pt-BR')}`
                    : 'Assinatura ativa'
                  : !isLoggedIn
                    ? 'Entre para acessar o NexusIDE'
                    : ''}
            </span>
          </div>
          {licenseUnconfirmed && (
            <span
              className="account__status"
              title="A assinatura criptográfica do arquivo local não pôde ser verificada nesta leitura — rede, chave pública ou arquivo. Nada indica que sua conta foi rejeitada."
            >
              Não conseguimos confirmar sua assinatura agora; nada de errado
              com sua conta. Tentaremos de novo.
            </span>
          )}
        </div>
        <span
          className={`account__session-pill${
            sessionBadge.tone === 'in'
              ? ' account__session-pill--in'
              : sessionBadge.tone === 'warn'
                ? ' account__session-pill--warn'
                : ''
          }`}
          data-session-tone={sessionBadge.tone}
        >
          {sessionBadge.label}
        </span>
        {sessionBadge.offerRelogin && !reloginOpen && (
          <button
            type="button"
            className="settings-btn"
            onClick={() => setReloginOpen(true)}
          >
            Entrar de novo
          </button>
        )}
        {isLoggedIn && (
          <button
            type="button"
            className="settings-btn"
            onClick={() => void openPortal()}
            title="Abrir o portal de assinatura (Stripe) no navegador"
          >
            Gerenciar assinatura
          </button>
        )}
      </div>

      {isLoggedIn && license?.access !== 'pro' && (
        <div className="account__redeem" role="group" aria-label="Resgatar código de licença">
          <LicenseCodeForm
            enabled={isLoggedIn}
            busy={redeemBusy}
            succeeded={redeemOk}
            error={redeemError}
            onSubmit={(code) => void redeemCode(code)}
          />
        </div>
      )}

      {showLogin && (
        <div className="account__login" role="region" aria-label="Entrar na conta Nexus">
          <div className="account__login-copy">
            <span className="account__zone-title">
              <PixelIcon name="user" size={13} />
              Entrar
            </span>
            <p className="account__zone-hint">
              Acesse seu plano e sua equipe em outras máquinas. As conexões
              com ferramentas de IA ficam em Contas de IA.
            </p>
          </div>
          {waitingProvider ? (
            <p className="account__notice" role="status">
              Continue no navegador: conclua o login com{' '}
              {loginProviderLabel(waitingProvider)} e volte aqui. O Nexus
              entra sozinho quando você terminar.
            </p>
          ) : null}
          <div className="account__login-buttons">
            {waitingProvider ? (
              <>
                <button
                  type="button"
                  className="settings-btn account__login-btn"
                  disabled={login.busy}
                  onClick={() => void login.start(waitingProvider)}
                >
                  {login.phase.kind === 'opening' ? 'Abrindo…' : 'Abrir de novo'}
                </button>
                <button
                  type="button"
                  className="settings-btn account__login-btn"
                  disabled={login.busy}
                  onClick={login.reset}
                >
                  Escolher outro método
                </button>
              </>
            ) : (
              LOGIN_PROVIDERS.map((provider, index) => (
                <button
                  key={provider}
                  type="button"
                  className={`settings-btn account__login-btn${index === 0 ? ' settings-btn--primary' : ''}`}
                  disabled={login.busy}
                  onClick={() => void login.start(provider)}
                >
                  <PixelIcon name="user" size={12} />
                  {login.phase.kind === 'opening' && login.phase.provider === provider
                    ? `Abrindo ${loginProviderLabel(provider)}…`
                    : `Entrar com ${loginProviderLabel(provider)}`}
                </button>
              ))
            )}
            {reloginOpen ? (
              // Aberto por "Entrar de novo" com a conta já ligada: sempre há
              // saída — a sessão atual continua como estava.
              <button
                type="button"
                className="settings-btn account__login-btn"
                disabled={login.busy}
                onClick={() => {
                  login.reset();
                  setReloginOpen(false);
                }}
              >
                Cancelar
              </button>
            ) : null}
          </div>
          {login.phase.kind === 'finishing' && (
            <p className="account__notice" role="status">
              Conta confirmada. Atualizando seu acesso…
            </p>
          )}
          {login.phase.kind === 'failed' && (
            <p className="account__notice account__notice--err" role="alert">
              {login.phase.message}
            </p>
          )}
          <p className="account__zone-hint">
            “Entrar com GitHub” conecta sua conta Nexus. Para PRs e issues no
            IDE (API do GitHub), configure um PAT no botão GitHub da barra do
            workspace.
          </p>
        </div>
      )}

      {isLoggedIn && !accessOnly && (
        <div className="account__team" role="region" aria-label="Time">
          <div className="account__team-head">
            <div>
              <span className="account__zone-title">
                <PixelIcon name="users" size={13} />
                Time
              </span>
              <p className="account__zone-hint">
                Compartilhe equipes e fluxos de trabalho com as pessoas do seu plano.
              </p>
            </div>
            {team?.team && (
              <span className="account__team-role">{roleLabel(team.team.role)}</span>
            )}
          </div>

          {teamLoading && (
            <p className="account__zone-hint" role="status">
              Carregando time…
            </p>
          )}

          {!teamLoading && team?.team ? (
            <>
              <div className="account__team-summary">
                <span className="account__team-name">{team.team.name}</span>
                <span className="account__team-seats">
                  {team.seats?.used ?? team.members?.length ?? 0}/
                  {team.seats?.total ?? 0} assentos
                  {team.overLimit ? ' · acima do limite' : ''}
                </span>
              </div>
              {team.members && team.members.length > 0 && (
                <ul className="account__members">
                  {team.members.map((member) => {
                    const label =
                      member.name ?? member.email ?? member.accountId;
                    return (
                      <li className="account__member" key={member.accountId}>
                        <span className="account__member-name">{label}</span>
                        <span className="account__member-role">
                          {roleLabel(member.role)}
                        </span>
                        {isOwner && member.role !== 'owner' && (
                          <button
                            type="button"
                            className="settings-btn settings-btn--danger account__member-action"
                            aria-label={`Remover ${label} do time`}
                            onClick={() =>
                              void removeMember(member.accountId, label)
                            }
                          >
                            Remover
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="account__team-actions">
                {isOwner && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void createInvite()}
                  >
                    Gerar convite
                  </button>
                )}
                {team.team.role === 'member' && (
                  <button
                    type="button"
                    className="settings-btn settings-btn--danger"
                    onClick={() => void leaveTeam()}
                  >
                    Sair do time
                  </button>
                )}
              </div>
              {inviteUrl && (
                <div className="account__invite">
                  <input
                    className="settings-input account__invite-url"
                    value={inviteUrl}
                    readOnly
                    aria-label="Link de convite do time"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void copyInvite()}
                  >
                    {inviteCopied ? 'Copiado' : 'Copiar link'}
                  </button>
                </div>
              )}
            </>
          ) : (
            !teamLoading && (
              <div className="account__join">
                <label className="account__field-label" htmlFor="account-join-code">
                  Código do convite
                </label>
                <div className="account__join-row">
                  <input
                    id="account-join-code"
                    className="settings-input"
                    placeholder="AB12-CD34"
                    value={joinCode}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setJoinCode(event.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void joinTeam();
                    }}
                  />
                  <button
                    type="button"
                    className="settings-btn settings-btn--primary"
                    disabled={!joinCode.trim()}
                    onClick={() => void joinTeam()}
                  >
                    Entrar no time
                  </button>
                </div>
              </div>
            )
          )}
          {teamError && (
            <p className="account__notice account__notice--err" role="alert">
              {teamError}
            </p>
          )}
        </div>
      )}

      <div className="account__plans-zone" role="region" aria-label="Planos">
        <div className="account__plans-head">
          <span className="account__zone-title">
            <PixelIcon name="star" size={13} />
            Planos
          </span>
          <p className="account__zone-hint">
            Compare os planos. Ao assinar, o pagamento abre no navegador
            pelo Stripe.
          </p>
        </div>
        <div className="account__plans">
          {PLANS.map((plan) => {
            const isCurrent = plan.id === license?.access;
            return (
              <article
                key={plan.id}
                className={`account__plan ${plan.id === 'pro' ? 'account__plan--featured' : ''} ${isCurrent ? 'account__plan--current' : ''}`}
                aria-current={isCurrent || undefined}
              >
                <div className="account__plan-head">
                  <span className="account__plan-title-row">
                    <span className="account__plan-name">{plan.name}</span>
                    {plan.promotionLabel && (
                      <span className="account__plan-promo">{plan.promotionLabel}</span>
                    )}
                  </span>
                  <span className="account__plan-price">
                    {planPrice(plan)}
                  </span>
                </div>
                <p className="account__plan-tagline">{plan.tagline}</p>
                {plan.id === 'trial' && <p className="account__zone-hint">Teste de 15 dias · 6 agentes simultâneos · sem sync na nuvem</p>}
                <ul className="account__plan-features">
                  {plan.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {isCurrent ? (
                  <span className="account__plan-badge">
                    <PixelIcon name="check" size={10} />
                    plano atual
                  </span>
                ) : plan.id === 'trial' ? (
                  <span className="account__plan-badge account__plan-badge--muted">
                    Começa no primeiro login
                  </span>
                ) : (
                  <>
                    {plan.id === 'pro' && (
                      <CheckoutChoices
                        group="account-interval"
                        value={checkoutChoice}
                        onChange={setCheckoutChoice}
                        disabled={checkoutBusy}
                      />
                    )}
                    <button
                      type="button"
                      className="settings-btn settings-btn--primary account__plan-cta"
                      disabled={checkoutBusy}
                      onClick={() => void startCheckout()}
                      title="Abrir checkout seguro da Stripe"
                    >
                    {checkoutBusy ? 'Abrindo…' : `Assinar ${plan.name}`}
                    </button>
                  </>
                )}
              </article>
            );
          })}
        </div>
        <p className="account__zone-hint account__billing-note">
          O teste dura 15 dias a partir do primeiro login verificado. Depois, o Pro
          custa R$ 59,99 por mês e pode ser contratado por 1, 3, 6 ou 12 meses,
          sempre esse valor vezes os meses. O único desconto é um cupom informado
          no checkout. A cobrança é em reais pela Stripe e pode ser cancelada no
          portal da assinatura.
        </p>
      </div>

      {checkoutError && (
        <p className="account__notice account__notice--err" role="alert">
          {checkoutError}
        </p>
      )}

      <p className="settings-detail__hint account__note">
        Pagamentos processados pela Stripe. Gerencie suas contas de IA em Providers.
      </p>
    </section>
  );
}

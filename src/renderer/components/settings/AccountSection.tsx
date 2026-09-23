import { useEffect, useState } from 'react';
import {
  PLANS,
  type LicenseState,
  type PlanDef,
  type PlanId,
  type TeamInfo,
} from '../../../shared/billing-types';
import type { PublicPlanId } from '../../../../shared/pricing';
import { askConfirm } from '../../state/confirm-store';
import { PixelIcon } from '../PixelIcon';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { accountSessionBadge, isSessionExpiredError } from './account-session-badge';

/**
 * Minha Conta — identidade Nexus (login), time e plano.
 * Checkout/portal abrem o browser no site de billing (Stripe); o app nunca
 * vê chaves de pagamento. Contas CLI (Claude/Codex/…) ficam em Providers.
 */

function planPrice(plan: PlanDef): string {
  if (plan.priceMonthlyMinor === 0) return 'Grátis para sempre';
  const formatted = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: plan.currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(plan.priceMonthlyMinor / 100);
  return `${formatted}/mês`;
}

function planName(id: PlanId): string {
  if (id === 'team') return 'Team (legado)';
  return PLANS.find((p) => p.id === id)?.name ?? id;
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

export function AccountSection() {
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(true);
  const [licenseFailed, setLicenseFailed] = useState(false);
  const [licenseRetry, setLicenseRetry] = useState(0);
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState<'github' | 'google' | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [reloginOpen, setReloginOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLicenseLoading(true);
    setLicenseFailed(false);
    void (async () => {
      try {
        const info = await window.nexus.billing.get();
        if (!cancelled) setLicense(info);
      } catch {
        if (!cancelled) setLicenseFailed(true);
      } finally {
        if (!cancelled) setLicenseLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [licenseRetry]);

  const isLoggedIn = Boolean(license?.email);
  // G7 (paridade 1.3.18): verificação de assinatura que falhou NÃO é falta de
  // licença. Com conta presente e verified=false, a tela fala "não confirmado
  // agora" em vez de acusar ausência ou empurrar checkout.
  const licenseUnconfirmed =
    isLoggedIn === true &&
    license?.verified === false &&
    (license.status !== 'none' || license.plan !== 'free');
  useEffect(() => {
    if (!isLoggedIn) {
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
  }, [isLoggedIn]);

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

  const startLogin = async (provider: 'github' | 'google') => {
    setLoginError(null);
    setLoginBusy(provider);
    try {
      const result = await window.nexus.app.authLogin(provider);
      if (!result.ok) {
        setLoginError(result.error ?? `Falha ao entrar com ${provider}.`);
        return;
      }
      const next = await window.nexus.billing.get();
      setLicense(next);
      if (reloginOpen) {
        setReloginOpen(false);
        setTeamError(null);
        setCheckoutError(null);
        await reloadTeam();
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Falha no login.');
    } finally {
      setLoginBusy(null);
    }
  };

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

  const startCheckout = async (plan: PublicPlanId) => {
    setCheckoutError(null);
    if (plan === 'free') {
      setCheckoutError('Use o portal para alterar uma assinatura ativa.');
      return;
    }
    setCheckoutBusy(true);
    try {
      const result = await window.nexus.billing.openCheckout(plan);
      if (!result.ok) {
        setCheckoutError(result.error ?? 'Não foi possível abrir o checkout.');
      }
    } finally {
      setCheckoutBusy(false);
    }
  };

  const sessionBadge = accountSessionBadge({
    loading: licenseLoading,
    isLoggedIn,
    licenseUnconfirmed,
    sessionExpired:
      isSessionExpiredError(teamError) || isSessionExpiredError(checkoutError),
  });
  const showLogin = !licenseLoading && (!isLoggedIn || reloginOpen);

  if (licenseLoading || licenseFailed) {
    return <section className="account" aria-busy={licenseLoading}>
      <AccountHeader />
      <div className="account__load-state" role={licenseFailed ? 'alert' : 'status'}>
        {licenseFailed ? <>
          <h3>Não foi possível carregar sua conta</h3>
          <p>Seu plano não pôde ser consultado agora. Tente novamente para ver os dados da conta.</p>
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => setLicenseRetry(value => value + 1)}>Tentar novamente</button>
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
              {planName(currentPlan)}
            </span>
            <span className="account__status">
              {licenseUnconfirmed
                ? 'Assinatura não confirmada agora'
                : license?.status === 'active'
                  ? license.renewsAt
                    ? `Renova em ${new Date(license.renewsAt).toLocaleDateString('pt-BR')}`
                    : 'Assinatura ativa'
                  : !isLoggedIn
                    ? 'Só nesta máquina'
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
        {license?.status === 'active' && (
          <button
            type="button"
            className="settings-btn"
            onClick={() => void window.nexus.billing.openPortal()}
            title="Abrir o portal de assinatura (Stripe) no navegador"
          >
            Gerenciar assinatura
          </button>
        )}
      </div>

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
          <div className="account__login-buttons">
            <button
              type="button"
              className="settings-btn settings-btn--primary account__login-btn"
              disabled={loginBusy !== null}
              onClick={() => void startLogin('github')}
            >
              <PixelIcon name="user" size={12} />
              {loginBusy === 'github' ? 'Abrindo GitHub…' : 'Entrar com GitHub'}
            </button>
            <button
              type="button"
              className="settings-btn account__login-btn"
              disabled={loginBusy !== null}
              onClick={() => void startLogin('google')}
            >
              <PixelIcon name="user" size={12} />
              {loginBusy === 'google' ? 'Abrindo Google…' : 'Entrar com Google'}
            </button>
            {reloginOpen ? (
              // Aberto por "Entrar de novo" com a conta já ligada: sempre há
              // saída — a sessão atual continua como estava.
              <button
                type="button"
                className="settings-btn account__login-btn"
                disabled={loginBusy !== null}
                onClick={() => setReloginOpen(false)}
              >
                Cancelar
              </button>
            ) : null}
          </div>
          {loginError && (
            <p className="account__notice account__notice--err" role="alert">
              {loginError}
            </p>
          )}
          <p className="account__zone-hint">
            “Entrar com GitHub” conecta sua conta Nexus. Para PRs e issues no
            IDE (API do GitHub), configure um PAT no botão GitHub da barra do
            workspace.
          </p>
        </div>
      )}

      {isLoggedIn && (
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
            const isCurrent = plan.id === currentPlan;
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
                ) : plan.id === 'free' ? (
                  <span className="account__plan-badge account__plan-badge--muted">
                    incluso
                  </span>
                ) : (
                  <button
                    type="button"
                    className="settings-btn settings-btn--primary account__plan-cta"
                    disabled={checkoutBusy}
                    onClick={() => void startCheckout(plan.id)}
                    title="Abrir checkout seguro da Stripe"
                  >
                    {checkoutBusy ? 'Abrindo…' : `Assinar ${plan.name}`}
                  </button>
                )}
              </article>
            );
          })}
        </div>
        <p className="account__zone-hint account__billing-note">
          O Free não expira. O Pro é cobrado mensalmente em reais pela Stripe e
          pode ser cancelado a qualquer momento no portal da assinatura.
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

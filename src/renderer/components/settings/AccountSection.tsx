import { useEffect, useState } from 'react';
import {
  PLANS,
  type LicenseInfo,
  type PlanDef,
  type PlanId,
  type TeamInfo,
} from '../../../shared/billing-types';
import type { PublicPlanId } from '../../../../shared/pricing';
import { askConfirm } from '../../state/confirm-store';
import { PixelIcon } from '../PixelIcon';

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

export function AccountSection() {
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(true);
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

  useEffect(() => {
    let cancelled = false;
    setLicenseLoading(true);
    void window.nexus.billing.get().then((info) => {
      if (cancelled) return;
      setLicense(info);
      setLicenseLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const isLoggedIn = Boolean(license?.email);
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

  return (
    <section className="account">
      <header className="account__intro">
        <h3 className="settings-detail__title">Minha Conta</h3>
        <p className="settings-detail__hint account__intro-hint">
          Login Nexus, time e plano. Contas das CLIs (Claude, Codex, Kimi…)
          ficam em Providers.
        </p>
      </header>

      <div
        className={`account__identity ${licenseLoading ? 'account__identity--loading' : ''} ${isLoggedIn ? 'account__identity--in' : ''}`}
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
          <span className="account__status">
            Plano <strong>{planName(currentPlan)}</strong>
            {license?.status === 'active' && license.renewsAt
              ? ` · renova em ${new Date(license.renewsAt).toLocaleDateString()}`
              : !isLoggedIn && !licenseLoading
                ? ' · só nesta máquina'
                : ''}
          </span>
        </div>
        <span
          className={`account__session-pill ${isLoggedIn ? 'account__session-pill--in' : ''}`}
        >
          {licenseLoading ? '…' : isLoggedIn ? 'conectado' : 'local'}
        </span>
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

      {!licenseLoading && !isLoggedIn && (
        <div className="account__login" role="region" aria-label="Entrar na conta Nexus">
          <div className="account__login-copy">
            <span className="account__zone-title">Entrar</span>
            <p className="account__zone-hint">
              Sincroniza plano, time e ranking entre máquinas. Não afeta logins
              das CLIs no vault local.
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
          </div>
          {loginError && (
            <p className="account__notice account__notice--err" role="alert">
              {loginError}
            </p>
          )}
        </div>
      )}

      {isLoggedIn && (
        <div className="account__team" role="region" aria-label="Time">
          <div className="account__team-head">
            <div>
              <span className="account__zone-title">Time</span>
              <p className="account__zone-hint">
                Squads e playbooks compartilhados com assentos do plano.
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
                  <code className="account__invite-url">{inviteUrl}</code>
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
          <span className="account__zone-title">Planos</span>
          <p className="account__zone-hint">
            Checkout no navegador (Stripe). O plano local fica em
            ~/.nexus/license.json.
          </p>
        </div>
        <div className="account__plans">
          {PLANS.map((plan) => {
            const isCurrent = plan.id === currentPlan;
            return (
              <article
                key={plan.id}
                className={`account__plan ${plan.id === 'pro' ? 'account__plan--featured' : ''} ${isCurrent ? 'account__plan--current' : ''}`}
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
                  <span className="account__plan-badge">plano atual</span>
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
        Pagamentos via Stripe no NexusIDE Cloud. Contas CLI e hot-swap de
        sessão ficam em Config → Providers.
      </p>
    </section>
  );
}

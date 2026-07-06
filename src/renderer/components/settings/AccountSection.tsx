import { useEffect, useState } from 'react';
import {
  PLANS,
  type LicenseInfo,
  type PlanId,
  type TeamInfo,
} from '../../../shared/billing-types';

/**
 * Minha Conta — plano atual + upgrade. O checkout/portal abrem o navegador no
 * site de billing (backend Stripe); o app nunca vê chaves de pagamento. Até o
 * SaaS ir ao ar, os CTAs deixam isso explícito em vez de fingir.
 */

function planPrice(price: number | null): string {
  if (price === null) return 'fale conosco';
  if (price === 0) return 'grátis';
  return `US$ ${price}/mês`;
}

export function AccountSection() {
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [teamCheckoutName, setTeamCheckoutName] = useState('');
  const [teamCheckoutSeats, setTeamCheckoutSeats] = useState(2);

  useEffect(() => {
    void window.nexus.billing.get().then(setLicense);
  }, []);

  const isLoggedIn = Boolean(license?.email);
  useEffect(() => {
    if (!isLoggedIn) {
      setTeam(null);
      return;
    }
    let cancelled = false;
    void window.nexus.team.get().then((result) => {
      if (cancelled) return;
      if (result.ok) setTeam(result.data ?? null);
      else setTeamError(result.error ?? 'não foi possível carregar o time');
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
      setTeamError(result.error ?? 'não foi possível atualizar o time');
    }
  };

  const joinTeam = async () => {
    const result = await window.nexus.team.join(joinCode);
    if (!result.ok) {
      setTeamError(result.error ?? 'não foi possível entrar no time');
      return;
    }
    setJoinCode('');
    await reloadTeam();
  };

  const createInvite = async () => {
    const result = await window.nexus.team.invite();
    if (!result.ok) {
      setTeamError(result.error ?? 'não foi possível gerar convite');
      return;
    }
    setInviteUrl(result.data?.url ?? null);
    setTeamError(null);
  };

  const leaveTeam = async () => {
    const result = await window.nexus.team.leave();
    if (!result.ok) {
      setTeamError(result.error ?? 'não foi possível sair do time');
      return;
    }
    setTeam(null);
    setInviteUrl(null);
  };

  const removeMember = async (accountId: string) => {
    const result = await window.nexus.team.removeMember(accountId);
    if (!result.ok) {
      setTeamError(result.error ?? 'não foi possível remover membro');
      return;
    }
    await reloadTeam();
  };

  const startCheckout = async (plan: PlanId) => {
    setCheckoutError(null);
    if (plan === 'free') {
      setCheckoutError('use o portal para alterar uma assinatura ativa');
      return;
    }
    const result = plan === 'team'
      ? await window.nexus.billing.openCheckout({
        plan,
        teamName: teamCheckoutName.trim(),
        seats: teamCheckoutSeats,
      })
      : await window.nexus.billing.openCheckout(plan);
    if (!result.ok) {
      setCheckoutError(result.error ?? 'não foi possível abrir o checkout');
    }
  };

  return (
    <section>
      <h3 className="settings-detail__title">Minha Conta</h3>
      <div className="account__identity">
        <span className="account__avatar" aria-hidden="true">
          👤
        </span>
        <div className="account__who">
          <span className="account__email">
            {license?.email ?? 'Conta local (sem login)'}
          </span>
          <span className="account__status">
            Plano <strong>{PLANS.find((p) => p.id === currentPlan)?.name}</strong>
            {license?.status === 'active' && license.renewsAt
              ? ` · renova em ${new Date(license.renewsAt).toLocaleDateString()}`
              : ''}
          </span>
        </div>
        {license?.status === 'active' && (
          <button
            className="agent-picker__btn"
            onClick={() => void window.nexus.billing.openPortal()}
            title="Abrir o portal de assinatura (Stripe) no navegador"
          >
            Gerenciar assinatura
          </button>
        )}
      </div>

      {!license?.email && (
        <div className="account__login">
          <span className="settings-detail__hint">
            Entre para sincronizar plano, times e ranking:
          </span>
          <div className="account__login-buttons">
            <button
              className="agent-picker__btn"
              onClick={() => void window.nexus.app.authLogin('github')}
            >
              Entrar com GitHub
            </button>
            <button
              className="agent-picker__btn"
              onClick={() => void window.nexus.app.authLogin('google')}
            >
              Entrar com Google
            </button>
          </div>
        </div>
      )}

      {license?.email && (
        <div className="account__team">
          <div className="account__team-head">
            <span className="account__team-title">Time</span>
            {team?.team && (
              <span className="account__team-role">
                {team.team.role === 'owner' ? 'owner' : 'member'}
              </span>
            )}
          </div>
          {team?.team ? (
            <>
              <div className="account__team-summary">
                <span className="account__team-name">{team.team.name}</span>
                <span className="settings-detail__hint">
                  {team.seats?.used ?? team.members?.length ?? 0}/{team.seats?.total ?? 0} assentos
                  {team.overLimit ? ' · acima do limite' : ''}
                </span>
              </div>
              {team.members && team.members.length > 0 && (
                <div className="account__members">
                  {team.members.map((member) => (
                    <div className="account__member" key={member.accountId}>
                      <span className="account__member-name">
                        {member.name ?? member.email ?? member.accountId}
                      </span>
                      <span className="account__member-role">{member.role}</span>
                      {isOwner && member.role !== 'owner' && (
                        <button
                          className="agent-picker__btn account__member-action"
                          onClick={() => void removeMember(member.accountId)}
                        >
                          Remover
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="account__team-actions">
                {isOwner && (
                  <button className="agent-picker__btn" onClick={() => void createInvite()}>
                    Gerar convite
                  </button>
                )}
                {team.team.role === 'member' && (
                  <button className="agent-picker__btn" onClick={() => void leaveTeam()}>
                    Sair do time
                  </button>
                )}
              </div>
              {inviteUrl && <code className="account__invite-url">{inviteUrl}</code>}
            </>
          ) : (
            <div className="account__join">
              <input
                className="settings-input"
                placeholder="AB12-CD34"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
              />
              <button className="agent-picker__btn" onClick={() => void joinTeam()}>
                Entrar num time
              </button>
            </div>
          )}
          {teamError && <span className="account__team-error">{teamError}</span>}
        </div>
      )}

      <div className="account__plans">
        {PLANS.map((plan) => {
          const isCurrent = plan.id === currentPlan;
          return (
            <div
              key={plan.id}
              className={`account__plan ${isCurrent ? 'account__plan--current' : ''}`}
            >
              <div className="account__plan-head">
                <span className="account__plan-name">{plan.name}</span>
                <span className="account__plan-price">{planPrice(plan.priceMonthly)}</span>
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
                <>
                  {plan.id === 'team' && (
                    <div className="account__team-checkout">
                      <input
                        className="settings-input"
                        placeholder="Nome do time"
                        value={teamCheckoutName}
                        onChange={(event) => setTeamCheckoutName(event.target.value)}
                      />
                      <input
                        className="settings-input account__seats-input"
                        min={2}
                        max={100}
                        type="number"
                        value={teamCheckoutSeats}
                        onChange={(event) => {
                          const seats = Number(event.target.value);
                          setTeamCheckoutSeats(Number.isFinite(seats) ? seats : 2);
                        }}
                      />
                    </div>
                  )}
                  <button
                    className="agent-picker__btn agent-picker__btn--primary account__plan-cta"
                    onClick={() => void startCheckout(plan.id)}
                    title="Abre o checkout no navegador"
                  >
                    {`Assinar ${plan.name}`}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {checkoutError && <span className="account__team-error">{checkoutError}</span>}

      <p className="settings-detail__hint account__note">
        Pagamentos via Stripe chegam com o NexusIDE Cloud — os botões acima já
        apontam para o fluxo de checkout. Seu plano fica em ~/.nexus/license.json.
      </p>
    </section>
  );
}

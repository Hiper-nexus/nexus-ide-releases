import { useEffect, useState } from 'react';
import {
  PLANS,
  type LicenseInfo,
  type PlanId,
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

  useEffect(() => {
    void window.nexus.billing.get().then(setLicense);
  }, []);

  const currentPlan: PlanId = license?.plan ?? 'free';

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
              ) : (
                <button
                  className="agent-picker__btn agent-picker__btn--primary account__plan-cta"
                  onClick={() => void window.nexus.billing.openCheckout(plan.id)}
                  title="Abre o checkout no navegador"
                >
                  {plan.priceMonthly === null ? 'Falar com a gente' : `Assinar ${plan.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="settings-detail__hint account__note">
        Pagamentos via Stripe chegam com o NexusIDE Cloud — os botões acima já
        apontam para o fluxo de checkout. Seu plano fica em ~/.nexus/license.json.
      </p>
    </section>
  );
}

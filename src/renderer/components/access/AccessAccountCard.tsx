import { useEffect, useRef } from 'react';
import { LOGIN_PROVIDERS, loginProviderLabel, type LoginProvider } from '../../../shared/auth-login';
import { waitingProviderOf, type NexusLogin } from '../settings/use-nexus-login';
import type { AccessPrimaryAction } from './access-view';
import { GitHubMark, GoogleMark } from './BrandMarks';
import { LicenseCodeForm } from './LicenseCodeForm';

export interface AccessAccountCardProps {
  email: string | null;
  primary: AccessPrimaryAction;
  login: NexusLogin;
  /** Quem ainda não entrou vê o teste de 15 dias como porta de entrada. */
  offerTrial: boolean;
  proPrice: string;
  promotion?: string;
  proFeatures: readonly string[];
  checkoutBusy: boolean;
  /** A consulta de acesso falhou e há como repeti-la. */
  canRetry: boolean;
  retrying: boolean;
  actionError: string | null;
  onCheckout: () => void;
  onPortal: () => void;
  onRetry: () => void;
  /** "Tenho um código": o resgate exige conta logada (canRedeem). */
  canRedeem: boolean;
  redeemBusy: boolean;
  redeemSucceeded: boolean;
  redeemError: string | null;
  onRedeem: (code: string) => void;
}

const initialFocusProps = { 'data-access-initial-focus': '' } as const;

function ProviderMark({ provider }: { provider: LoginProvider }) {
  return provider === 'github' ? <GitHubMark /> : <GoogleMark />;
}

/**
 * Conta na tela de bloqueio: UM painel com duas zonas (entrar | planos), nunca
 * dois cartões. A ação principal é a única em branco; o resto não compete.
 * Apresentacional: a rede e o estado do login vivem em AccountSection.
 */
export function AccessAccountCard(props: AccessAccountCardProps) {
  const { login, primary } = props;
  const { phase } = login;
  const panelRef = useRef<HTMLElement>(null);
  const waitingRef = useRef<HTMLDivElement>(null);
  const previousKind = useRef(phase.kind);
  const waitingProvider = waitingProviderOf(phase);

  useEffect(() => {
    const before = previousKind.current;
    previousKind.current = phase.kind;
    if (phase.kind === 'waiting') {
      // Também após "Abrir de novo": o botão focado ficou desabilitado no meio.
      waitingRef.current?.focus({ preventScroll: true });
    } else if ((before === 'waiting' || before === 'opening') && (phase.kind === 'idle' || phase.kind === 'failed')) {
      // A espera (ou o botão desabilitado) sumiu com o foco: devolve ao CTA.
      panelRef.current?.querySelector<HTMLElement>('[data-access-initial-focus]:not(:disabled)')
        ?.focus({ preventScroll: true });
    }
  }, [phase.kind]);

  const retryButton = props.canRetry && (
    <button
      type="button"
      className={`access-btn${primary === 'retry' ? ' access-btn--primary' : ' access-btn--quiet'}`}
      disabled={props.retrying}
      onClick={props.onRetry}
      {...(primary === 'retry' ? initialFocusProps : {})}
    >
      {props.retrying ? 'Consultando…' : 'Tentar novamente'}
    </button>
  );

  return (
    <section className="access-panel" aria-label="Minha conta" ref={panelRef}>
      <div className="access-panel__gate">
        {props.email && <p className="access-who">Conectado como <strong>{props.email}</strong></p>}
        {primary === 'retry' && retryButton}

        {phase.kind === 'failed' && <p className="access-error" role="alert">{phase.message}</p>}

        {waitingProvider ? (
          <div className="access-wait" role="status" tabIndex={-1} ref={waitingRef}>
            <span className="access-wait__pulse" aria-hidden="true" />
            <div className="access-wait__copy">
              <p className="access-wait__title">Continue no navegador</p>
              <p>
                Conclua o login com {loginProviderLabel(waitingProvider)} e volte aqui.
                O Nexus entra sozinho quando você terminar.
              </p>
            </div>
            <div className="access-wait__actions">
              <button type="button" className="access-btn" disabled={login.busy} onClick={() => void login.start(waitingProvider)}>
                {phase.kind === 'opening' ? 'Abrindo…' : 'Abrir de novo'}
              </button>
              <button type="button" className="access-btn access-btn--quiet" disabled={login.busy} onClick={login.reset}>
                Escolher outro método
              </button>
            </div>
          </div>
        ) : (
          <div className="access-providers">
            {LOGIN_PROVIDERS.map((provider) => {
              const label = loginProviderLabel(provider);
              const opening = phase.kind === 'opening' && phase.provider === provider;
              const isPrimary = primary === 'login' && provider === 'github';
              return (
                <button
                  key={provider}
                  type="button"
                  className={`access-btn access-btn--provider${isPrimary ? ' access-btn--primary' : ''}`}
                  disabled={login.busy}
                  onClick={() => void login.start(provider)}
                  {...(isPrimary ? initialFocusProps : {})}
                >
                  <ProviderMark provider={provider} />
                  {opening ? `Abrindo ${label}…` : `Entrar com ${label}`}
                </button>
              );
            })}
          </div>
        )}

        {primary !== 'retry' && retryButton}
        {phase.kind === 'finishing' && (
          <p className="access-fineprint" role="status">Conta confirmada. Atualizando seu acesso…</p>
        )}
        {!waitingProvider && phase.kind !== 'finishing' && (
          <p className="access-fineprint">
            {props.email
              ? 'Não é esta conta? Entre de novo com outra pelo navegador.'
              : 'O login abre no navegador. Quando você terminar, o Nexus continua aqui.'}
          </p>
        )}
      </div>

      <aside className="access-panel__plans" aria-label="Planos">
        <dl className="access-plans">
          {props.offerTrial && (
            <div className="access-plans__row">
              <dt>Teste de 15 dias</dt>
              <dd>2 agentes · sem sync na nuvem. Começa no primeiro login.</dd>
            </div>
          )}
          <div className="access-plans__row">
            <dt>Pro</dt>
            <dd className="access-plans__price">
              <span>{props.proPrice}</span>
              {props.promotion && <small>{props.promotion}</small>}
            </dd>
            <dd>{props.proFeatures.join(' · ')}</dd>
          </div>
        </dl>
        <div className="access-plans__actions">
          <button
            type="button"
            className={`access-btn${primary === 'checkout' ? ' access-btn--primary' : ''}`}
            disabled={props.checkoutBusy}
            onClick={props.onCheckout}
            {...(primary === 'checkout' ? initialFocusProps : {})}
          >
            {props.checkoutBusy ? 'Abrindo…' : 'Assinar Pro'}
          </button>
          <button
            type="button"
            className={`access-btn${primary === 'portal' ? ' access-btn--primary' : ' access-btn--quiet'}`}
            onClick={props.onPortal}
            {...(primary === 'portal' ? initialFocusProps : {})}
          >
            Gerenciar assinatura
          </button>
        </div>
        <LicenseCodeForm
          enabled={props.canRedeem}
          busy={props.redeemBusy}
          succeeded={props.redeemSucceeded}
          error={props.redeemError}
          onSubmit={props.onRedeem}
        />
        {props.actionError && <p className="access-error" role="alert">{props.actionError}</p>}
      </aside>
    </section>
  );
}

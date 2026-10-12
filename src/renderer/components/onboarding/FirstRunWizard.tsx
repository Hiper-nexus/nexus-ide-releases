import { useEffect, useRef } from 'react';
import { PixelIcon } from '../PixelIcon';
import {
  useOnboardingStore,
  stepIdForIndex,
} from '../../state/onboarding-store';
import {
  ONBOARDING_STEP_IDS,
  type OnboardingStepId,
} from '../../../shared/onboarding-state-types';
import { useProviderStore } from '../../state/provider-store';
import {
  isLocalCliProvider,
  providerStatusLabel,
} from '../settings/providers-panel-view';

export interface FirstRunWizardHandlers {
  onOpenApiKeys: () => void;
  onOpenProviders: () => void;
  onOpenWorkspace: () => void;
  onStartMission: () => void;
  onOpenPane: () => void;
  onOpenShellTerminal: () => void;
}

const STEP_META: Record<
  OnboardingStepId,
  { label: string; title: string; lead: string }
> = {
  keys: {
    label: 'Chaves',
    title: 'Colocar suas chaves',
    lead: 'As IAs do Nexus usam a sua conta ou a sua chave. Você configura uma vez.',
  },
  agents: {
    label: 'Agentes',
    title: 'Agentes prontos',
    lead: 'Escolha um agente para começar a codar. Dá para acrescentar outros depois.',
  },
  project: {
    label: 'Projeto',
    title: 'Seu primeiro projeto',
    lead: 'O trabalho começa numa pasta do computador — a que você já tem ou uma nova.',
  },
  use: {
    label: 'Usar',
    title: 'Como usar o Nexus',
    lead: 'Três atalhos que mudam o dia a dia. Guarde estes.',
  },
};

function StepKeys({ onOpenApiKeys, onOpenProviders }: FirstRunWizardHandlers) {
  return (
    <div className="onboarding-step__body">
      <ol className="onboarding-path" aria-label="Onde colocar as chaves">
        <li>
          <strong>Ajustes → Chaves de API</strong>
          <p>Cole a chave (por exemplo <code>sk-…</code>) do provedor que você usa.</p>
        </li>
        <li>
          <strong>Providers → Entrar</strong>
          <p>
            Para CLIs locais (Codex, Claude e outras), faça login na conta — o
            Nexus detecta a sessão.
          </p>
        </li>
      </ol>
      <div className="onboarding-actions">
        <button type="button" className="onboarding-btn onboarding-btn--primary" onClick={onOpenApiKeys}>
          Abrir Chaves de API
        </button>
        <button type="button" className="onboarding-btn" onClick={onOpenProviders}>
          Abrir Providers
        </button>
      </div>
      <p className="onboarding-note">
        Prefere configurar depois? Pule — o checklist da tela inicial continua
        te esperando.
      </p>
    </div>
  );
}

function StepAgents({ onOpenProviders }: FirstRunWizardHandlers) {
  const providers = useProviderStore((s) => s.providers);
  const agents = providers.filter((p) => p.enabled).slice(0, 6);

  return (
    <div className="onboarding-step__body">
      {agents.length === 0 ? (
        <p className="onboarding-note">
          Nenhuma ferramenta de IA conectada ainda. Abra Providers para entrar
          numa conta ou colar uma chave — depois elas aparecem aqui como
          «Pronto».
        </p>
      ) : (
        <ul className="onboarding-agent-list" aria-label="Agentes">
          {agents.map((provider) => {
            const status = providerStatusLabel(provider);
            const ready =
              provider.authState === 'ok' || provider.hasKey;
            return (
              <li key={provider.adapterId} className="onboarding-agent">
                <span className="onboarding-agent__icon" aria-hidden="true">
                  <PixelIcon
                    name={isLocalCliProvider(provider) ? 'terminal' : 'key'}
                    size={16}
                  />
                </span>
                <div className="onboarding-agent__copy">
                  <strong>{provider.label}</strong>
                  <span>{status.label}</span>
                </div>
                <span
                  className={`onboarding-badge${ready ? ' onboarding-badge--ok' : ''}`}
                >
                  {ready ? 'Pronto' : 'Falta login'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="onboarding-actions">
        <button
          type="button"
          className="onboarding-btn onboarding-btn--primary"
          onClick={onOpenProviders}
        >
          Conectar outra conta
        </button>
      </div>
    </div>
  );
}

function StepProject({
  onOpenWorkspace,
  onStartMission,
}: FirstRunWizardHandlers) {
  return (
    <div className="onboarding-step__body">
      <div className="onboarding-choices">
        <button type="button" className="onboarding-choice" onClick={onOpenWorkspace}>
          <strong>Abrir projeto existente</strong>
          <span>Escolha uma pasta do computador para continuar de onde parou.</span>
        </button>
        <button type="button" className="onboarding-choice" onClick={onStartMission}>
          <strong>Criar com IA</strong>
          <span>Conte sua ideia e prepare a primeira missão.</span>
        </button>
      </div>
    </div>
  );
}

function StepUse({
  onOpenApiKeys,
  onOpenPane,
  onStartMission,
  onOpenWorkspace,
  onOpenShellTerminal,
}: FirstRunWizardHandlers) {
  return (
    <div className="onboarding-step__body">
      <ul className="onboarding-howto" aria-label="Como usar o Nexus">
        <li>
          <strong>Space (segurar) = ditar</strong>
          <p>
            Segure Space e fale; solte para transcrever no terminal selecionado.
            Toque curto continua sendo um espaço. ⌘⇧Space fala com a assistente.
          </p>
        </li>
        <li>
          <strong>+ Pane</strong>
          <p>
            O botão + da grade abre outro painel de IA ou terminal — cada um com
            a sua ferramenta.
          </p>
        </li>
        <li>
          <strong>Onde ficam as chaves</strong>
          <p>Ajustes → Chaves de API · Providers para login de CLI.</p>
        </li>
      </ul>
      <div className="onboarding-actions onboarding-actions--wrap">
        <button type="button" className="onboarding-btn" onClick={onOpenPane}>
          Experimentar + Pane
        </button>
        <button type="button" className="onboarding-btn" onClick={onStartMission}>
          Criar com IA
        </button>
        <button type="button" className="onboarding-btn" onClick={onOpenWorkspace}>
          Abrir projeto
        </button>
        <button type="button" className="onboarding-btn" onClick={onOpenShellTerminal}>
          Terminal sem IA
        </button>
        <button type="button" className="onboarding-btn" onClick={onOpenApiKeys}>
          Chaves de API
        </button>
      </div>
      <p className="onboarding-note">
        Formas de iniciar: Criar com IA · Montar meus terminais · Abrir projeto ·
        Terminal sem IA · + Pane.
      </p>
    </div>
  );
}

/**
 * First-run wizard (T3-style stepper) in the house modal language.
 * Skip is always allowed; Esc closes as dismiss.
 */
export function FirstRunWizard(handlers: FirstRunWizardHandlers) {
  const wizardOpen = useOnboardingStore((s) => s.wizardOpen);
  const stepIndex = useOnboardingStore((s) => s.stepIndex);
  const setStepIndex = useOnboardingStore((s) => s.setStepIndex);
  const completeStep = useOnboardingStore((s) => s.completeStep);
  const closeWizard = useOnboardingStore((s) => s.closeWizard);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!wizardOpen) return undefined;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closeWizard('dismissed');
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [wizardOpen, closeWizard]);

  if (!wizardOpen) return null;

  const stepId = stepIdForIndex(stepIndex);
  const meta = STEP_META[stepId];
  const isLast = stepIndex >= ONBOARDING_STEP_IDS.length - 1;

  const advance = () => {
    completeStep(stepIndex + 1);
    if (isLast) {
      closeWizard('completed');
      return;
    }
    setStepIndex(stepIndex + 1);
  };

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding__overlay" onClick={() => closeWizard('dismissed')} />
      <div className="onboarding__panel">
        <header className="onboarding__header">
          <p className="onboarding__brand">
            <span className="onboarding__brand-nexus">Nexus</span>
            <span className="onboarding__brand-code">Primeiros passos</span>
          </p>
          <h2 id="onboarding-title" className="onboarding__title">
            {meta.title}
          </h2>
          <p className="onboarding__lead">{meta.lead}</p>
          <ol className="onboarding-stepper" aria-label="Progresso do onboarding">
            {ONBOARDING_STEP_IDS.map((id, i) => {
              const done = i < stepIndex;
              const current = i === stepIndex;
              return (
                <li
                  key={id}
                  className={`onboarding-stepper__item${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                  aria-current={current ? 'step' : undefined}
                >
                  <span className="onboarding-stepper__index" aria-hidden="true">
                    {done ? '✓' : i + 1}
                  </span>
                  <span className="onboarding-stepper__label">{STEP_META[id].label}</span>
                </li>
              );
            })}
          </ol>
        </header>

        {stepId === 'keys' && <StepKeys {...handlers} />}
        {stepId === 'agents' && <StepAgents {...handlers} />}
        {stepId === 'project' && <StepProject {...handlers} />}
        {stepId === 'use' && <StepUse {...handlers} />}

        <footer className="onboarding__footer">
          <button
            type="button"
            className="onboarding-btn"
            onClick={() => closeWizard('dismissed')}
          >
            Pular
          </button>
          {stepIndex > 0 ? (
            <button
              type="button"
              className="onboarding-btn"
              onClick={() => setStepIndex(stepIndex - 1)}
            >
              Voltar
            </button>
          ) : null}
          <button
            ref={primaryRef}
            type="button"
            className="onboarding-btn onboarding-btn--primary"
            onClick={advance}
          >
            {isLast ? 'Começar' : 'Continuar'}
          </button>
        </footer>
      </div>
    </div>
  );
}

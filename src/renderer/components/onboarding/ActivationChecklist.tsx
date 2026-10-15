import {
  activationChecklistRemaining,
  useOnboardingStore,
  type ActivationChecklistKey,
} from '../../state/onboarding-store';
import { PixelIcon, type PixelIconName } from '../PixelIcon';

export interface ActivationChecklistHandlers {
  onOpenProviders: () => void;
  onOpenWorkspace: () => void;
  onExplainDictation: () => void;
  onOpenPane: () => void;
  onStartMission: () => void;
}

const ITEMS: Array<{
  key: ActivationChecklistKey;
  label: string;
  hint: string;
  icon: PixelIconName;
  actionLabel: string;
  action: keyof ActivationChecklistHandlers;
}> = [
  {
    key: 'connectedAccount',
    label: 'Conecte uma IA ou chave',
    hint: 'Abra Configurações → Contas de IA para entrar na sua conta, ou Chaves de API para usar uma chave.',
    icon: 'key',
    actionLabel: 'Conectar minha conta',
    action: 'onOpenProviders',
  },
  {
    key: 'openedProject',
    label: 'Abra um projeto',
    hint: 'Escolha a pasta do trabalho que você quer evoluir.',
    icon: 'files',
    actionLabel: 'Escolher pasta',
    action: 'onOpenWorkspace',
  },
  {
    key: 'dictatedWithSpace',
    label: 'Dite com Space',
    hint: 'Segure Space e fale; solte para transcrever no terminal.',
    icon: 'mic',
    actionLabel: 'Como funciona',
    action: 'onExplainDictation',
  },
  {
    key: 'openedPlusPane',
    label: 'Abra um + Pane',
    hint: 'Outro painel de IA ou terminal pela grade.',
    icon: 'grid',
    actionLabel: 'Abrir + Pane',
    action: 'onOpenPane',
  },
  {
    key: 'createdMission',
    label: 'Crie a primeira missão',
    hint: 'Descreva o objetivo e acompanhe a entrega.',
    icon: 'mission',
    actionLabel: 'Criar com IA',
    action: 'onStartMission',
  },
];

/** Residual activation checklist — marks real product facts, never traps the operator. */
export function ActivationChecklist(handlers: ActivationChecklistHandlers) {
  const checklist = useOnboardingStore((s) => s.state.checklist);
  const setChecklist = useOnboardingStore((s) => s.setChecklist);
  const dismissChecklist = useOnboardingStore((s) => s.dismissChecklist);

  if (checklist.dismissed) return null;
  if (activationChecklistRemaining(checklist).length === 0) return null;

  return (
    <section
      className="activation-checklist"
      aria-labelledby="activation-checklist-title"
    >
      <header className="activation-checklist__header">
        <h2 id="activation-checklist-title" className="launcher__section-title">
          Primeiros passos
        </h2>
        <button
          type="button"
          className="activation-checklist__dismiss"
          onClick={dismissChecklist}
        >
          Entendi, não mostrar de novo
        </button>
      </header>
      <ul className="activation-checklist__list">
        {ITEMS.map((item) => {
          const done = checklist[item.key];
          return (
            <li
              key={item.key}
              className={`activation-checklist__item${done ? ' is-done' : ''}`}
            >
              <span className="activation-checklist__mark" aria-hidden="true">
                {done ? '✓' : <PixelIcon name={item.icon} size={12} />}
              </span>
              <div className="activation-checklist__copy">
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </div>
              {done ? (
                <span className="activation-checklist__done-label">Feito</span>
              ) : (
                <span className="activation-checklist__actions">
                  <button
                    type="button"
                    className="onboarding-btn onboarding-btn--small"
                    onClick={() => setChecklist(item.key, true)}
                  >
                    Marcar
                  </button>
                  <button
                    type="button"
                    className="onboarding-btn onboarding-btn--small onboarding-btn--primary"
                    onClick={handlers[item.action]}
                  >
                    {item.actionLabel}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

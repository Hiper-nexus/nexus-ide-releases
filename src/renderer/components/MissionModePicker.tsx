import type { WizardMode } from '../state/mission-wizard-store';
import { PixelIcon } from './PixelIcon';

interface MissionModePickerProps {
  selectedMode: WizardMode | null;
  squadCount: number;
  hasPlanningSquad: boolean;
  onChooseMode: (mode: WizardMode) => void;
  onChoosePlanning: () => void;
}

/**
 * First decision in Nova Missão. The product promise is autopilot, so the
 * outcome-first path leads; manual terminals remain one click away.
 */
export function MissionModePicker({
  selectedMode,
  squadCount,
  hasPlanningSquad,
  onChooseMode,
  onChoosePlanning,
}: MissionModePickerProps) {
  return (
    <div className="wizard__modes wizard__modes--featured">
      <button
        type="button"
        className={`wizard__mode wizard__mode--featured ${
          selectedMode === 'agentic' ? 'wizard__mode--active' : ''
        }`}
        onClick={() => onChooseMode('agentic')}
      >
        <span className="wizard__mode-badge wizard__mode-badge--rec">
          Recomendado
        </span>
        <span className="wizard__mode-icon">
          <PixelIcon name="bolt" size={22} />
        </span>
        <span className="wizard__mode-title">Piloto automático</span>
        <span className="wizard__mode-desc">
          Descreva o resultado. O Nexus monta o time, executa, revisa e testa.
        </span>
        <span className="wizard__mode-cta">Começar pelo objetivo ›</span>
      </button>

      <button
        type="button"
        className={`wizard__mode wizard__mode--featured ${
          selectedMode === 'libre' ? 'wizard__mode--active' : ''
        }`}
        onClick={() => onChooseMode('libre')}
      >
        <span className="wizard__mode-badge">Controle manual</span>
        <span className="wizard__mode-icon">
          <PixelIcon name="terminal" size={22} />
        </span>
        <span className="wizard__mode-title">Modo Livre</span>
        <span className="wizard__mode-desc">
          Abra a grade e escolha cada terminal ou provider por conta própria.
        </span>
        <span className="wizard__mode-cta">Configurar terminais ›</span>
      </button>

      <button
        type="button"
        className={`wizard__mode wizard__mode--featured ${
          selectedMode === 'squad' ? 'wizard__mode--active' : ''
        }`}
        onClick={() => onChooseMode('squad')}
        disabled={squadCount === 0}
      >
        <span className="wizard__mode-badge">Time salvo</span>
        <span className="wizard__mode-icon">
          <PixelIcon name="users" size={22} />
        </span>
        <span className="wizard__mode-title">Modo Squad</span>
        <span className="wizard__mode-desc">
          Reuse um time pronto no mesmo objetivo, com trabalho em paralelo.
          {squadCount === 0 && ' (nenhum squad salvo)'}
        </span>
        <span className="wizard__mode-cta">Escolher squad ›</span>
      </button>

      {hasPlanningSquad && (
        <button
          type="button"
          className="wizard__mode wizard__mode--featured"
          onClick={onChoosePlanning}
        >
          <span className="wizard__mode-badge">Feature nova</span>
          <span className="wizard__mode-icon">
            <PixelIcon name="board" size={22} />
          </span>
          <span className="wizard__mode-title">Planejar · PRD</span>
          <span className="wizard__mode-desc">
            O squad lê seu código, entrevista você e entrega PRD, arquitetura e
            stories prontas.
          </span>
          <span className="wizard__mode-cta">Planejar feature ›</span>
        </button>
      )}
    </div>
  );
}

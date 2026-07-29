import type { Mission } from '../../shared/orch-types';
import {
  PRIOR_MISSION_MEMORY_MARKER,
} from '../../shared/mission-result-format';

const MISSION_LEARNINGS_LIMIT = 65_536;

function missionResultSections(learnings: string): {
  finalReport: string;
  priorContext: string;
} {
  const normalized = learnings.trim();
  const currentMarkerIndex = normalized.lastIndexOf(
    PRIOR_MISSION_MEMORY_MARKER,
  );
  if (currentMarkerIndex >= 0) {
    return {
      finalReport: normalized.slice(0, currentMarkerIndex).trim(),
      priorContext: normalized
        .slice(currentMarkerIndex + PRIOR_MISSION_MEMORY_MARKER.length)
        .trim(),
    };
  }
  const verifiedMarkers = [
    ...normalized.matchAll(
      /^##[ \t]+Conclusão automática verificada[ \t]*$/gimu,
    ),
  ];
  const latestMarker = verifiedMarkers.at(-1);
  if (latestMarker?.index === undefined) {
    return { finalReport: normalized, priorContext: '' };
  }
  return {
    finalReport: normalized.slice(latestMarker.index).trim(),
    priorContext: normalized.slice(0, latestMarker.index).trim(),
  };
}

function missionResultStatus(mission: Mission): string {
  if (mission.status === 'done') return 'Concluída';
  if (mission.status === 'failed') return 'Falhou';
  if (mission.status === 'blocked') return 'Encerrada com bloqueio';
  return 'Encerrada';
}

function missionResultMoment(mission: Mission): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(mission.updatedAt);
}

function MissionResultContent({ mission }: { mission: Mission }) {
  const { finalReport, priorContext } = missionResultSections(
    mission.learnings,
  );
  const reachedStorageLimit =
    mission.learnings.length >= MISSION_LEARNINGS_LIMIT;
  return (
    <section
      className="mission-result__delivery"
      aria-labelledby="mission-result-delivery-title"
    >
      <h3 id="mission-result-delivery-title">Resultado final</h3>
      {reachedStorageLimit && (
        <p className="mission-result__limit-note" role="note">
          O relatório atingiu o limite de 64 KiB; conteúdo além desse ponto
          pode ter sido truncado.
        </p>
      )}
      {finalReport ? (
        <pre
          className="mission-result__output"
          data-testid="mission-result-output"
          tabIndex={0}
        >
          {finalReport}
        </pre>
      ) : (
        <p className="mission-result__empty">
          Esta missão foi encerrada sem relatório final persistido.
        </p>
      )}
      {priorContext && (
        <details className="mission-result__history">
          <summary>Memória anterior da missão</summary>
          <pre>{priorContext}</pre>
        </details>
      )}
    </section>
  );
}

export function MissionResultDetail({
  mission,
  onBack,
}: {
  mission: Mission;
  onBack: () => void;
}) {
  return (
    <article
      className="mission-result"
      data-testid="mission-result-detail"
      aria-labelledby="mission-result-title"
    >
      <button
        type="button"
        className="orch-panel__btn mission-result__back"
        onClick={onBack}
      >
        Voltar às missões
      </button>
      <header className="mission-result__header">
        <span className={`orch-badge orch-badge--${mission.status}`}>
          {missionResultStatus(mission)}
        </span>
        <h2 id="mission-result-title">{mission.title}</h2>
        <p>
          Relatório durável · atualizado em {missionResultMoment(mission)}
        </p>
      </header>
      {mission.description && (
        <p className="mission-result__description">{mission.description}</p>
      )}
      <MissionResultContent mission={mission} />
    </article>
  );
}

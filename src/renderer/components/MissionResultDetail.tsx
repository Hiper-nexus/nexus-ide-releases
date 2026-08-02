import type { Mission } from '../../shared/orch-types';
import {
  PRIOR_MISSION_MEMORY_MARKER,
} from '../../shared/mission-result-format';
import { presentMissionFailure } from '../../shared/mission-failure-presentation';

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
  switch (mission.status) {
    case 'pending':
      return 'Planejada';
    case 'running':
      return 'Em andamento';
    case 'done':
      return 'Concluída';
    case 'failed':
      return 'Falhou';
    case 'blocked':
      return 'Encerrada com bloqueio';
  }
}

function emptyMissionResult(mission: Mission): string {
  if (mission.status === 'pending') {
    return 'A missão ainda não começou; o relatório será criado durante a execução.';
  }
  if (mission.status === 'running') {
    return 'A missão está em andamento; o relatório final será persistido quando a cadeia concluir.';
  }
  return 'Esta missão foi encerrada sem relatório final persistido.';
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
          {emptyMissionResult(mission)}
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
  onReopen,
}: {
  mission: Mission;
  onBack: () => void;
  /** Present only when the mission can be resumed (e.g. technical block). */
  onReopen?: () => void;
}) {
  const failure = presentMissionFailure(mission.description ?? '');
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
      {failure.summary && (
        <p className="mission-result__description">{failure.summary}</p>
      )}
      {failure.sections.length > 0 && (
        <section
          className="mission-result__diagnostic"
          aria-labelledby="mission-result-diagnostic-title"
          data-testid="mission-result-diagnostic"
        >
          <h3 id="mission-result-diagnostic-title">Diagnóstico da falha</h3>
          {failure.sections.map((section, index) => (
            <article
              key={`${section.title}-${index}`}
              className="mission-result__diagnostic-item"
            >
              <h4>{section.title}</h4>
              <p>{section.body}</p>
            </article>
          ))}
          {onReopen && (
            <button
              type="button"
              className="orch-panel__btn mission-result__reopen"
              onClick={onReopen}
              title="Replaneja e retoma a missão a partir do diagnóstico acima"
            >
              Retomar missão
            </button>
          )}
        </section>
      )}
      <MissionResultContent mission={mission} />
    </article>
  );
}

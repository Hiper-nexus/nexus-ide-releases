import { useState } from 'react';
import type { Mission } from '../../shared/orch-types';
import {
  PRIOR_MISSION_MEMORY_MARKER,
} from '../../shared/mission-result-format';
import { presentMissionFailure } from '../../shared/mission-failure-presentation';
import {
  hasAutomaticTechnicalRecovery,
  parseRecoveryAttemptBlock,
} from '../../shared/mission-recovery-policy';
import { askConfirm } from '../state/confirm-store';
import { MissionWaveSchedule } from './MissionWaveSchedule';
import { MissionControlBoard } from './MissionControlBoard';

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
  if (hasAutomaticTechnicalRecovery(mission)) {
    const attempt = parseRecoveryAttemptBlock(mission.description ?? '');
    return attempt
      ? `Recuperando ${attempt.attempt}/${attempt.maxAttempts}`
      : 'Recuperando';
  }
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

function missionResultBadgeTone(mission: Mission): Mission['status'] | 'running' {
  return hasAutomaticTechnicalRecovery(mission) ? 'running' : mission.status;
}

function emptyMissionResult(mission: Mission): string {
  if (mission.status === 'pending') {
    return 'A missão ainda não começou; o relatório será criado durante a execução.';
  }
  if (
    mission.status === 'running' ||
    hasAutomaticTechnicalRecovery(mission)
  ) {
    return 'A missão está em andamento; o relatório final será persistido quando a cadeia concluir.';
  }
  if (mission.status === 'done') {
    return (
      'Esta missão foi marcada como concluída sem relatório final. ' +
      'Se o plano de controle abaixo ainda mostra ondas pendentes, o fechamento ' +
      'foi cedo demais: o trabalho do executor pode ter sido entregue, mas ' +
      'revisor/QA não rodaram. Para seguir o desenvolvimento, abra uma nova missão ' +
      'a partir do último commit — não espere este relatório “continuar sozinho”.'
    );
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

const RECOVERY_ESCALATION_MIN_ATTEMPT = 3;
const RECOVERY_ESCALATION_AGE_MS = 10 * 60_000;

function MissionRecoveryStatus({ mission }: { mission: Mission }) {
  const [busy, setBusy] = useState<'resume' | 'close' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!hasAutomaticTechnicalRecovery(mission)) return null;
  const attempt = parseRecoveryAttemptBlock(mission.description ?? '');
  const ageMs = attempt ? Date.now() - Date.parse(attempt.at) : 0;
  const stuck =
    attempt !== null &&
    (attempt.attempt >= RECOVERY_ESCALATION_MIN_ATTEMPT ||
      ageMs > RECOVERY_ESCALATION_AGE_MS);

  async function forceResume(): Promise<void> {
    setBusy('resume');
    setNotice(null);
    try {
      const result = await window.nexus.orch.resumeMissionBootstrap({
        missionId: mission.id,
      });
      setNotice(
        result.ok
          ? 'Retomada forçada: o bootstrap revalidou as autoridades e seguiu.'
          : `A retomada forçada parou: ${result.error}`,
      );
    } catch {
      setNotice('Não foi possível forçar a retomada agora.');
    } finally {
      setBusy(null);
    }
  }

  async function closeRuntime(): Promise<void> {
    const confirmed = await askConfirm({
      title: 'Encerrar execução da missão',
      body:
        `Encerrar a execução de "${mission.title}" preserva histórico e ` +
        'receipts, mas interrompe a recuperação automática desta revisão.',
      confirmLabel: 'Encerrar execução',
      danger: true,
    });
    if (!confirmed) return;
    setBusy('close');
    setNotice(null);
    try {
      const result = await window.nexus.orch.closeMissionRuntime(mission.id);
      setNotice(
        result.ok
          ? 'Execução encerrada; histórico preservado.'
          : `Não foi possível encerrar: ${result.error ?? 'falha sem detalhe'}.`,
      );
    } catch {
      setNotice('Não foi possível encerrar a execução agora.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="mission-result__diagnostic"
      aria-labelledby="mission-recovery-status-title"
      data-testid="mission-recovery-status"
    >
      <h3 id="mission-recovery-status-title">Recuperação automática</h3>
      {attempt ? (
        <p data-testid="mission-recovery-attempt">
          Tentativa {attempt.attempt} de {attempt.maxAttempts} ·{' '}
          {attempt.reason}
        </p>
      ) : (
        <p>Nenhuma tentativa registrada ainda — a primeira está em voo.</p>
      )}
      {stuck && (
        <>
          <p>
            A recuperação não está cedendo. Você pode forçar uma retomada
            imediata ou encerrar a execução e revisar o plano.
          </p>
          <button
            type="button"
            className="orch-panel__btn"
            onClick={() => void forceResume()}
            disabled={busy !== null}
          >
            {busy === 'resume' ? 'Retomando…' : 'Forçar retomada'}
          </button>
          <button
            type="button"
            className="orch-panel__btn"
            onClick={() => void closeRuntime()}
            disabled={busy !== null}
          >
            {busy === 'close' ? 'Encerrando…' : 'Encerrar execução'}
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
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
        <span
          className={`orch-badge orch-badge--${missionResultBadgeTone(mission)}`}
        >
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
              title={
                mission.intentState === 'blocked_user'
                  ? 'Escolha o caminho (ou replaneje a missão a partir desta decisão)'
                  : 'Replaneja e retoma a missão a partir do diagnóstico acima'
              }
            >
              {mission.intentState === 'blocked_user'
                ? 'Escolher caminho / retomar'
                : 'Retomar missão'}
            </button>
          )}
        </section>
      )}
      <MissionControlBoard missionId={mission.id} />
      <MissionWaveSchedule missionId={mission.id} />
      <MissionRecoveryStatus mission={mission} />
      <MissionResultContent mission={mission} />
    </article>
  );
}

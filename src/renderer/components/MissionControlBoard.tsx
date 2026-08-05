import { useEffect, useState } from 'react';
import type {
  MissionControlPaneActivity,
  MissionControlSnapshot,
} from '../../shared/mission-control-plane';
import { missionControlPulse } from '../../shared/mission-control-pulse';
import { formatAgo } from '../lib/ops-board';

const ACTIVITY_LABELS: Record<MissionControlPaneActivity, string> = {
  working: 'trabalhando',
  idle: 'ocioso',
  dead: 'morto',
  unknown: 'desconhecido',
};

const REFRESH_MS = 4_000;

/**
 * Espelho humano do plano de controle (P1-0 · slice 2).
 *
 * O operador via o que a UI decidia mostrar; o orquestrador via a missão
 * inteira. Esta superfície fecha a assimetria: os MESMOS panes com atividade
 * viva, a MESMA fila com ondas, o MESMO mapa de posse e os MESMOS bloqueios
 * que `nexus_mission_control` devolve ao piloto — numa leitura, com o pulso
 * ("tem algo rodando?") na primeira linha.
 *
 * Nunca some: missão sem pane vivo continua renderizando fila e bloqueios,
 * porque pane fechado não pode significar trabalho invisível.
 */
export function MissionControlBoard({
  missionId,
}: {
  readonly missionId: string;
}) {
  const [snapshot, setSnapshot] = useState<MissionControlSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controlPlane = window.nexus?.orch?.missionControlPlane;
    if (!controlPlane) return;
    const load = () => {
      void controlPlane(missionId)
        .then((result) => {
          if (!cancelled) setSnapshot(result ?? null);
        })
        .catch(() => {
          if (!cancelled) setSnapshot(null);
        });
    };
    load();
    // "Vivo" é o requisito: o operador não deve reperguntar se algo roda.
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [missionId]);

  if (!snapshot) return null;

  const pulse = missionControlPulse(snapshot);
  const waves = new Map<number, MissionControlSnapshot['queue'][number][]>();
  for (const entry of snapshot.queue) {
    const list = waves.get(entry.waveHint) ?? [];
    list.push(entry);
    waves.set(entry.waveHint, list);
  }
  const orderedWaves = [...waves.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <section
      className="mission-control-board"
      aria-labelledby="mission-control-board-title"
      data-testid="mission-control-board"
    >
      <h3 id="mission-control-board-title">Plano de controle</h3>
      <p
        className="mission-control-board__pulse"
        data-testid="mission-control-pulse"
        data-running={pulse.running}
      >
        <strong>{pulse.headline}</strong>
        {pulse.explanation ? <> · {pulse.explanation}</> : null}
      </p>

      <h4>Panes da missão</h4>
      {snapshot.panes.length === 0 ? (
        <p className="mission-control-board__empty">
          Nenhum pane vivo agora — a fila e os bloqueios abaixo continuam
          sendo o estado real da missão.
        </p>
      ) : (
        <ul className="mission-control-board__panes">
          {snapshot.panes.map((pane) => (
            <li
              key={pane.paneId}
              data-activity={pane.activity}
              data-testid={`mission-control-pane-${pane.paneId}`}
            >
              <strong>{pane.title ?? pane.paneId}</strong>
              {pane.agentName ? ` — ${pane.agentName}` : ''} ·{' '}
              {ACTIVITY_LABELS[pane.activity]}
              {pane.currentTaskTitle
                ? ` · em ${pane.currentTaskTitle}`
                : pane.currentTaskId
                  ? ` · em ${pane.currentTaskId}`
                  : ''}
              {typeof pane.lastHeartbeatAt === 'number'
                ? ` · sinal ${formatAgo(snapshot.generatedAt, pane.lastHeartbeatAt)}`
                : ''}
            </li>
          ))}
        </ul>
      )}

      {orderedWaves.length > 0 && (
        <>
          <h4>Fila</h4>
          <ol className="mission-control-board__queue">
            {orderedWaves.map(([wave, entries]) => (
              <li key={wave}>
                <strong>Onda {wave}</strong>
                <ul>
                  {entries.map((entry) => (
                    <li key={entry.taskId} data-status={entry.status}>
                      {entry.title}
                      {entry.agentName ? ` — ${entry.agentName}` : ''} ·{' '}
                      {entry.dispatchState ?? entry.status}
                      {entry.lastError ? ` · ${entry.lastError}` : ''}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      )}

      {snapshot.ownership.length > 0 && (
        <>
          <h4>Posse por task</h4>
          <ul className="mission-control-board__ownership">
            {snapshot.ownership.map((entry) => (
              <li key={entry.taskId}>
                <strong>{entry.taskId}</strong> · {entry.workerId}
                {entry.files.length > 0 ? ` · ${entry.files.join(', ')}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}

      {snapshot.blocks.length > 0 && (
        <>
          <h4>Bloqueios</h4>
          <ul className="mission-control-board__blocks">
            {snapshot.blocks.map((block, index) => (
              <li key={`${block.scope}-${block.taskId ?? index}`}>
                {block.taskId ? <strong>{block.taskId} · </strong> : null}
                {block.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

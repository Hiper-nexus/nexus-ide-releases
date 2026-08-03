import { useEffect, useState } from 'react';
import type { MissionTaskScheduleItem } from '../../shared/mission-task-schedule';

const STATUS_LABELS: Record<MissionTaskScheduleItem['status'], string> = {
  pending: 'pendente',
  running: 'ativo',
  done: 'concluída',
  blocked: 'bloqueada',
  failed: 'falhou',
};

/**
 * The wave schedule the operator was never shown: which tasks run side by
 * side and which wait for a merge. Fetched ONCE on demand (the detail view
 * re-renders on store updates), never per item, never polling — absence of
 * data renders nothing instead of a promise.
 */
export function MissionWaveSchedule({
  missionId,
}: {
  readonly missionId: string;
}) {
  const [tasks, setTasks] = useState<MissionTaskScheduleItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const scheduleFor = window.nexus?.orch?.missionTaskSchedule;
    if (!scheduleFor) return;
    void scheduleFor({ missionId })
      .then((result) => {
        if (!cancelled) setTasks(result.tasks ?? []);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  if (!tasks || tasks.length === 0) return null;

  const waves = new Map<number, MissionTaskScheduleItem[]>();
  for (const task of tasks) {
    const list = waves.get(task.waveHint) ?? [];
    list.push(task);
    waves.set(task.waveHint, list);
  }
  const orderedWaves = [...waves.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <section
      className="mission-result__diagnostic"
      aria-labelledby="mission-wave-schedule-title"
      data-testid="mission-wave-schedule"
    >
      <h3 id="mission-wave-schedule-title">Cronograma de ondas</h3>
      <p>
        Uma task de mutação por vez em cada área (single-writer): revisores
        entram após o merge do executor. Tarefas na mesma onda rodam em
        paralelo.
      </p>
      <ol className="mission-wave-schedule__waves">
        {orderedWaves.map(([wave, waveTasks]) => (
          <li key={wave}>
            <strong>Onda {wave}</strong>
            <ul>
              {waveTasks.map((task) => (
                <li key={task.taskId} data-status={task.status}>
                  {task.title}
                  {task.agentName ? ` — ${task.agentName}` : ''}
                  {task.stage ? ` (${task.stage})` : ''} ·{' '}
                  {STATUS_LABELS[task.status]}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

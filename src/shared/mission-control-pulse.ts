/**
 * Pulso do plano de controle (P1-0 · slice 2).
 *
 * A pergunta que o operador teve de repetir a sessão inteira — "tem alguma
 * coisa rodando?" — respondida numa linha, sobre o snapshot da slice 1. E,
 * quando a resposta é "nada", a segunda linha diz POR QUÊ: parecer ocioso é
 * legítimo numa fase sequencial, desde que a fase seja nomeada. Módulo puro:
 * deriva do snapshot, não consulta nada.
 */
import {
  ACTIVE_DISPATCH_STATES,
  type MissionControlQueueEntry,
  type MissionControlSnapshot,
} from './mission-control-plane';

export interface MissionControlPulse {
  readonly workingPanes: number;
  readonly idlePanes: number;
  readonly deadPanes: number;
  /** Itens da fila efetivamente em voo (status ou dispatch ativo). */
  readonly running: number;
  /** Pendentes cujas dependências já concluíram — poderiam começar AGORA. */
  readonly eligible: number;
  /** Pendentes travados por dependência ainda não concluída. */
  readonly waitingOnDeps: number;
  readonly done: number;
  readonly blocked: number;
  readonly headline: string;
  readonly explanation: string | null;
}

function isInFlight(entry: MissionControlQueueEntry): boolean {
  return (
    entry.status === 'running' ||
    (entry.dispatchState !== undefined &&
      ACTIVE_DISPATCH_STATES.has(entry.dispatchState))
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function headlineFor(pulse: {
  queueSize: number;
  running: number;
  blocked: number;
  eligible: number;
  waitingOnDeps: number;
  done: number;
}): string {
  if (pulse.queueSize === 0) return 'Sem fila';
  if (pulse.running > 0) {
    return `${pulse.running} ${plural(pulse.running, 'unidade', 'unidades')} ${plural(pulse.running, 'trabalhando', 'trabalhando')} agora`;
  }
  if (pulse.blocked > 0) {
    return `Nada rodando — ${pulse.blocked} ${plural(pulse.blocked, 'bloqueio', 'bloqueios')}`;
  }
  if (pulse.eligible > 0) {
    return (
      `Nada rodando — ${pulse.eligible} ` +
      `${plural(pulse.eligible, 'unidade elegível', 'unidades elegíveis')} ` +
      'aguardando despacho'
    );
  }
  if (pulse.waitingOnDeps > 0) {
    return `Nada rodando — ${pulse.waitingOnDeps} aguardando dependências`;
  }
  if (pulse.done === pulse.queueSize) return 'Fila concluída';
  return 'Nada rodando';
}

function explanationFor(
  snapshot: MissionControlSnapshot,
  counts: { deadPanes: number; eligible: number; waitingOnDeps: number },
): string | null {
  // Um bloqueio nomeado explica a missão melhor que qualquer contagem.
  const namedBlock = snapshot.blocks.find((block) => block.text.length > 0);
  if (namedBlock) return namedBlock.text;
  if (counts.deadPanes > 0) {
    return (
      `${counts.deadPanes} ` +
      `${plural(counts.deadPanes, 'pane morto', 'panes mortos')} na missão.`
    );
  }
  // Parado com fila cheia só é aceitável se a fase for nomeada.
  if (counts.waitingOnDeps === 0) return null;
  const tail =
    `${counts.waitingOnDeps} ` +
    `${plural(counts.waitingOnDeps, 'aguarda', 'aguardam')} dependências.`;
  if (counts.eligible === 0) {
    return `Fase sequencial: nenhuma outra unidade elegível — ${tail}`;
  }
  return (
    `Fase sequencial: só ${counts.eligible} ` +
    `${plural(counts.eligible, 'unidade elegível', 'unidades elegíveis')} — ${tail}`
  );
}

export function missionControlPulse(
  snapshot: MissionControlSnapshot,
): MissionControlPulse {
  const doneTasks = new Set(
    snapshot.queue
      .filter((entry) => entry.status === 'done')
      .map((entry) => entry.taskId),
  );

  let running = 0;
  let eligible = 0;
  let waitingOnDeps = 0;
  for (const entry of snapshot.queue) {
    if (isInFlight(entry)) {
      running += 1;
      continue;
    }
    if (entry.status !== 'pending') continue;
    if (entry.dependsOn.every((dep) => doneTasks.has(dep))) eligible += 1;
    else waitingOnDeps += 1;
  }

  const workingPanes = snapshot.panes.filter(
    (pane) => pane.activity === 'working',
  ).length;
  const idlePanes = snapshot.panes.filter(
    (pane) => pane.activity === 'idle',
  ).length;
  const deadPanes = snapshot.panes.filter(
    (pane) => pane.activity === 'dead',
  ).length;
  const blocked = snapshot.blocks.length;

  return {
    workingPanes,
    idlePanes,
    deadPanes,
    running,
    eligible,
    waitingOnDeps,
    done: doneTasks.size,
    blocked,
    headline: headlineFor({
      queueSize: snapshot.queue.length,
      running,
      blocked,
      eligible,
      waitingOnDeps,
      done: doneTasks.size,
    }),
    explanation: explanationFor(snapshot, {
      deadPanes,
      eligible,
      waitingOnDeps,
    }),
  };
}

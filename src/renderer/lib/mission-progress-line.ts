/**
 * Sinal de progresso quando NÃO há tarefas planejadas.
 *
 * Na Via Rápida `progress.total` é 0, e o contador some — correto, porque
 * "0 / 0" é ruído. Mas o efeito colateral era pior: durante todo o trabalho a
 * pessoa não via NENHUM sinal de que algo estava acontecendo, e a missão
 * parecia travada. Aqui a contagem vem dos agentes, que existem sempre.
 */
import type { MissionAgentSnapshot } from '../../shared/mission-engine-contract';

/** Estados de agente que contam como "trabalhando agora". */
const WORKING_STATES = new Set(['busy', 'working', 'running']);

export interface QualitativeProgress {
  readonly line: string;
  readonly working: number;
  readonly total: number;
}

/**
 * Frase de progresso a partir dos agentes vivos. Devolve null quando não há
 * equipe — aí não há o que dizer, e inventar seria pior.
 */
export function qualitativeProgress(
  agents: readonly MissionAgentSnapshot[],
): QualitativeProgress | null {
  const workers = agents.filter((agent) => agent.category !== 'orchestrator');
  if (workers.length === 0) return null;

  const working = workers.filter((agent) =>
    WORKING_STATES.has(String(agent.state)),
  ).length;
  const total = workers.length;

  if (working === 0) {
    return {
      line:
        total === 1
          ? 'A equipe está organizando o trabalho'
          : `A equipe (${total}) está organizando o trabalho`,
      working,
      total,
    };
  }
  return {
    line:
      working === 1
        ? `1 de ${total} trabalhando agora`
        : `${working} de ${total} trabalhando agora`,
    working,
    total,
  };
}

/** Tempo decorrido em linguagem de gente. */
export function elapsedLabel(
  startedAtMs: number,
  nowMs: number,
): string | null {
  const seconds = Math.floor((nowMs - startedAtMs) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'há menos de um minuto';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? 'há 1 minuto' : `há ${minutes} minutos`;
  }
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? 'há 1 hora' : `há ${hours} horas`;
}

/** A frase que tira a ansiedade: o trabalho não depende da tela aberta. */
export const MISSION_BACKGROUND_NOTICE =
  'Pode fechar esta tela — a missão continua e aparece no rail quando terminar.';

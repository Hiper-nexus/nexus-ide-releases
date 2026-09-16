/**
 * ADOÇÃO de orquestrador: uma missão nova assume um pane que JÁ está vivo, em
 * vez de subir o seu próprio Maestro.
 *
 * Por que isto existe: "Tornar orquestrador" num painel solto não tinha para
 * onde ir. Criar a missão e depois amarrar o painel MATAVA o painel — o
 * respawn da Via Rápida termina fisicamente qualquer sessão de orquestrador
 * registrada antes de subir a dele (mission-fast-lane: "NUNCA spawnar por cima
 * de um orquestrador registrado"). O operador perdia o terminal em que estava
 * trabalhando para ganhar um Maestro em branco.
 *
 * A reserva abaixo é o canal entre quem TEM o WebContents (a camada IPC, que
 * sabe conceder autoridade de missão a uma sessão viva) e quem manda na
 * sequência de arranque (a Via Rápida). Ela é de um uso só e expira: uma
 * autorização de adoção nunca pode sobreviver ao pedido que a criou.
 */

/** Janela da reserva. Um start que não chega aqui em 2 min não é mais o mesmo. */
export const ORCHESTRATOR_ADOPTION_TTL_MS = 120_000;

export interface OrchestratorAdoptionReservation {
  readonly missionId: string;
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  /**
   * Concede autoridade de missão à sessão viva e devolve se foi aceita. Quem
   * fornece isto é a camada que tem o WebContents dono do pane — a Via Rápida
   * não inventa autoridade, ela só pergunta.
   */
  readonly grantAuthority: () => boolean | Promise<boolean>;
  readonly expiresAt: number;
}

/** Por que uma adoção não aconteceu. Nunca é silêncio: vira aviso para o operador. */
export type OrchestratorAdoptionRefusal =
  | 'no-reservation'
  | 'expired'
  | 'session-dead'
  | 'adapter-cannot-orchestrate'
  | 'authority-refused';

export type OrchestratorAdoptionDecision =
  | { readonly kind: 'adopt'; readonly reservation: OrchestratorAdoptionReservation }
  | { readonly kind: 'spawn'; readonly refusal: OrchestratorAdoptionRefusal };

const reservations = new Map<string, OrchestratorAdoptionReservation>();

export function reserveOrchestratorAdoption(
  reservation: OrchestratorAdoptionReservation,
): void {
  reservations.set(reservation.missionId, reservation);
}

/** Consome a reserva: leitura destrói. Duas adoções da mesma reserva nunca. */
export function takeOrchestratorAdoption(
  missionId: string,
): OrchestratorAdoptionReservation | null {
  const reservation = reservations.get(missionId);
  if (!reservation) return null;
  reservations.delete(missionId);
  return reservation;
}

export function clearOrchestratorAdoption(missionId: string): void {
  reservations.delete(missionId);
}

/** Só para teste: a tabela é de processo e não deve vazar entre casos. */
export function resetOrchestratorAdoptionsForTest(): void {
  reservations.clear();
}

/**
 * Decisão pura, sem Electron. A regra é fail-SAFE em uma direção só: qualquer
 * dúvida vira `spawn` — a missão sempre arranca. O que NÃO pode acontecer é
 * adotar uma sessão que não está viva ou um CLI que não sabe orquestrar, porque
 * aí a missão ficaria "running" com um Maestro mudo.
 */
export function decideOrchestratorAdoption(input: {
  readonly reservation: OrchestratorAdoptionReservation | null;
  readonly now: number;
  readonly sessionIsLive: boolean;
  readonly adapterCanOrchestrate: boolean;
}): OrchestratorAdoptionDecision {
  if (!input.reservation) return { kind: 'spawn', refusal: 'no-reservation' };
  if (input.reservation.expiresAt <= input.now) {
    return { kind: 'spawn', refusal: 'expired' };
  }
  if (!input.sessionIsLive) return { kind: 'spawn', refusal: 'session-dead' };
  if (!input.adapterCanOrchestrate) {
    return { kind: 'spawn', refusal: 'adapter-cannot-orchestrate' };
  }
  return { kind: 'adopt', reservation: input.reservation };
}

const REFUSAL_COPY: Record<OrchestratorAdoptionRefusal, string> = {
  'no-reservation': 'nenhum painel foi indicado para liderar',
  expired: 'o pedido demorou demais e o painel indicado foi liberado',
  'session-dead': 'o painel indicado não estava mais rodando',
  'adapter-cannot-orchestrate':
    'a ferramenta desse painel não sabe coordenar uma missão (use Claude ou Codex)',
  'authority-refused': 'a missão não aceitou esse painel como líder',
};

/**
 * Frase para o operador. A adoção que não acontece NUNCA é silenciosa: ele
 * pediu que aquele painel liderasse e vai ver um Maestro novo na tela — sem
 * esta frase, parece bug.
 */
export function orchestratorAdoptionRefusalMessage(
  refusal: OrchestratorAdoptionRefusal,
): string {
  return `O painel escolhido não assumiu a missão: ${REFUSAL_COPY[refusal]}. A missão abriu com um coordenador próprio.`;
}

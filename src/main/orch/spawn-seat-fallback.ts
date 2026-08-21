/**
 * F-101: spawn com `missing-credential` não pode matar o assento — o seat
 * caminha a CADEIA de sucessão (shared/seat-chains, mesma regra do remint
 * do revisor) e o primeiro elo com credencial present senta. Paridade
 * Overclock: capacidade ausente DEGRADA (troca de adapter), nunca bloqueia
 * a missão esperando um pane que nunca nasce.
 *
 * Só falhas da classe credencial autorizam a cadeia; erro de modelo selado,
 * sandbox ou CLI ausente continua fail-closed visível.
 */
import { firstSeatableCli } from '../../shared/seat-chains';
import { PreSpawnProbeError } from '../pty/pre-spawn-probe';

/** Códigos do pre-spawn probe que representam "sem credencial utilizável". */
export const CREDENTIAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  'missing-credential',
  'key-missing',
]);

export function isCredentialProbeFailure(
  error: unknown,
): error is PreSpawnProbeError {
  return (
    error instanceof PreSpawnProbeError &&
    CREDENTIAL_FAILURE_CODES.has(error.code)
  );
}

export type SeatFallbackDeps = {
  readonly isSpawnableCli: (cli: string) => boolean;
  readonly hasPresentAuth: (cli: string) => boolean;
  /** Escalação explícita; default: PREFERRED_AUTO_SEAT_CLIS. */
  readonly preferred?: readonly string[];
};

export function seatSuccessorForFailedSeat(input: {
  readonly failedCli: string;
  readonly deps: SeatFallbackDeps;
  /** Já tentados nesta resolução — evita ping-pong na cadeia. */
  readonly visited?: ReadonlySet<string>;
}): string | null {
  const visited = input.visited ?? new Set<string>();
  return firstSeatableCli({
    primaryCli: input.failedCli,
    preferred: input.deps.preferred,
    canSeat: (cli) =>
      cli !== input.failedCli &&
      !visited.has(cli) &&
      input.deps.isSpawnableCli(cli) &&
      input.deps.hasPresentAuth(cli),
  });
}

/**
 * Caminha a cadeia sondando cada candidato; o primeiro que passa no probe
 * senta. Falha não-credencial num candidato é propagada (fail-closed);
 * credencial ausente avança. Sem elo viável → null (chamador mantém a
 * falha original VISÍVEL).
 */
export async function settleSeatAfterCredentialFailure(input: {
  readonly failedCli: string;
  readonly probe: (cli: string) => Promise<void>;
  readonly deps: SeatFallbackDeps;
}): Promise<string | null> {
  const visited = new Set<string>([input.failedCli]);
  let cursor = input.failedCli;
  for (;;) {
    const next = seatSuccessorForFailedSeat({
      failedCli: cursor,
      deps: input.deps,
      visited,
    });
    if (!next) return null;
    try {
      await input.probe(next);
      return next;
    } catch (error) {
      if (!isCredentialProbeFailure(error)) throw error;
      visited.add(next);
      cursor = next;
    }
  }
}

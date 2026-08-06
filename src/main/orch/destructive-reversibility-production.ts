/**
 * Preparador de produção da reversibilidade destrutiva (N1).
 *
 * Junta as três metades — planejar (puro), executar (IO injetado) e o adaptador
 * de sistema — numa função só, que é a forma que o dispatch consome. Existe
 * para que o wiring seja UM ponto: um segundo caminho de dispatch que esquecesse
 * de ligar isto voltaria a perguntar, e ninguém notaria.
 */
import { planDestructiveReversibility } from './destructive-reversibility';
import {
  prepareDestructiveReversibility,
  type ReversibilityIo,
} from './destructive-reversibility-io';
import type { DestructiveReversibilityPreparer } from './mcp-dispatch-contract';

export function createDestructiveReversibilityPreparer(
  io: ReversibilityIo,
  now: () => number = Date.now,
): DestructiveReversibilityPreparer {
  return async ({ command, cwd }) => {
    const receipt = await prepareDestructiveReversibility(
      planDestructiveReversibility(command),
      { cwd, io, now: now() },
    );
    return { revertPath: receipt.revertPath, reversible: receipt.reversible };
  };
}

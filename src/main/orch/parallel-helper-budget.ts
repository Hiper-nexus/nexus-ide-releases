/**
 * Orçamento de paralelismo do AGORA (F-784): sessões de agente vivas (contagem
 * em memória do pty-manager) contra o teto da máquina e a última amostra de
 * memória do kernel — o cache que o gate de spawn (F-572) já usa, renovado
 * fora do caminho por `execFile` assíncrono (boot, broadcast de 30 s, guardian
 * e cada spawn). Nada síncrono pesado no Main. Nunca lança: telemetria com
 * defeito vira "sem orçamento", fail-open como o gate de admissão.
 *
 * O teto de agentes da licença (Trial = 6) entra aqui, na camada do Main:
 * `parallelHelperBudget` é puro e só recebe o número.
 */
import { maxAgents } from '../license-access';
import { countLiveAgentSessions } from '../pty/pty-manager';
import {
  getCachedSystemMemory,
  parallelHelperBudget,
  readPaneAdmissionLimits,
  type ParallelHelperBudget,
} from './pane-admission';

export function currentParallelHelperBudget(
  now: number = Date.now(),
): ParallelHelperBudget | null {
  try {
    return parallelHelperBudget({
      liveAgentPanes: countLiveAgentSessions(),
      limits: readPaneAdmissionLimits(),
      memory: getCachedSystemMemory(now),
      licenseMaxAgents: maxAgents(),
    });
  } catch {
    return null;
  }
}

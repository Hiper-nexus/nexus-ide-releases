import type { MissionOrchestratorRuntimeSnapshot } from '../../shared/mission-intent';
import { getAccount } from '../persistence/account-store';

/**
 * F-1470: a conta física do Maestro não precisa ser a aprovada. Como em
 * `sameMissionOrchestratorGrantRuntime`, a conta é política main-owned: o
 * seletor escolhe a conta com folga e o failover F-995 troca a conta quando
 * ela esgota. Vale a conta aprovada; qualquer conta numa missão aprovada sem
 * conta (builds antigos); ou outra conta que o Main conhece no MESMO provider
 * aprovado — o store guarda a conta por adapter e o spawn só prepara conta do
 * próprio adapter. Sem conta física, vale só se a aprovação também não tinha.
 * Conta de outro provider, ou desconhecida e diferente da aprovada, continua
 * recusada, com ou sem conta aprovada.
 *
 * Módulo próprio de propósito: `mission-orchestrator-runtime` monta as deps
 * de produção no load, e o fast-lane não pode carregá-lo.
 */
export function missionOrchestratorAccountAllowed(
  approved: Pick<MissionOrchestratorRuntimeSnapshot, 'adapterId' | 'accountId'>,
  accountId: string | undefined,
): boolean {
  if (accountId === approved.accountId) return true;
  if (!accountId) return !approved.accountId?.trim();
  return getAccount(accountId)?.adapterId === approved.adapterId;
}

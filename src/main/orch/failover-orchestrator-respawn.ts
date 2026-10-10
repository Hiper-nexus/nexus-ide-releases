/**
 * F-995: troca de conta do ORQUESTRADOR de missão que mora num pane do
 * renderer — inclusive o pane do operador adotado pela missão da aba.
 *
 * Em 07/10 o orquestrador Claude bateu o limite de 5 Horas, o Main decidiu a
 * troca para a outra conta Claude e emitiu "switched", mas o renderer não
 * religou nada: `respawnWithResume` não mexe em pane cuja missão ainda o
 * possui, o renderer nem pode matar sessão de missão (`killSession`), e a
 * cerca do spawn persistido exige a conta SELADA da composição. O pane ficou
 * parado na conta esgotada enquanto o registro já apontava a conta nova — e
 * cada novo "limit reached" era suprimido como "provider-api-healthy".
 *
 * Aqui o Main é o dono da troca, pelo caminho que já religa orquestradores
 * (`requestMissionPaneRecovery`): troca a conta selada da linha do
 * orquestrador (CAS na conta esperada), encerra a sessão exausta com prova
 * física e pede ao renderer o religamento no MESMO pane, com o pacote de
 * continuidade como recap. O resultado só é "ok" depois que a sessão nova
 * existe e foi religada à missão.
 */
import { isDeepStrictEqual } from 'node:util';
import type { MissionPaneSpec } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { isPtySessionConnectedAndWritable, listAgentSessionsForPane } from '../pty/pty-manager';
import { requestMissionPaneRecovery } from './pane-registry';
import { getProjectDomainStores, sameProjectExecutionScope } from './project-domain-store-registry';

export interface OrchestratorAccountSwitchInput {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly paneId: string;
  readonly sessionId: string;
  readonly toAccountId: string;
  /**
   * Pacote de continuidade entregue como primeira mensagem da sessão nova.
   * Montado só depois que o pane se prova o orquestrador selado (lê o PTY).
   */
  readonly buildRecap: () => string;
}

export type OrchestratorAccountSwitchResult =
  /** Não é o orquestrador selado desta missão: segue o caminho de sempre. */
  | { readonly handled: false }
  | { readonly handled: true; readonly ok: true; readonly sessionId: string }
  | { readonly handled: true; readonly ok: false; readonly error: string };

export interface OrchestratorAccountSwitchDeps {
  readonly findSpec: (
    scope: ProjectExecutionScope,
    paneId: string,
  ) => MissionPaneSpec | null;
  readonly rebindAccount: (
    scope: ProjectExecutionScope,
    missionId: string,
    paneId: string,
    expectedAccountId: string | null,
    accountId: string,
  ) => MissionPaneSpec | null;
  readonly requestRecovery: typeof requestMissionPaneRecovery;
}

const productionDeps: OrchestratorAccountSwitchDeps = {
  findSpec: (scope, paneId) =>
    getProjectDomainStores(scope).missionPanes.findByPaneId(paneId),
  rebindAccount: (scope, missionId, paneId, expected, accountId) =>
    getProjectDomainStores(scope).missionPanes.rebindPaneAccount(
      missionId,
      paneId,
      expected,
      accountId,
    ),
  // Ligação tardia: o binding só é lido na chamada, nunca no load do módulo.
  requestRecovery: (options) => requestMissionPaneRecovery(options),
};

/**
 * F-1131: requestId vazio prova que o Main recusou ANTES de emitir um grant
 * de substituição. Timeout/tombstone/exception não dão essa prova. Só volta
 * B→A com o MESMO PTY A ainda conectado, inventário exclusivo e composição
 * intacta; CAS preserva qualquer escolha concorrente. Nenhum await separa a
 * prova da compensação. Sem prova, mantém B: nunca desfaz um efeito tardio.
 */
function restoreAccountAfterPreflightRefusal(
  input: OrchestratorAccountSwitchInput,
  original: MissionPaneSpec,
  rebound: MissionPaneSpec,
  result: Awaited<ReturnType<typeof requestMissionPaneRecovery>>,
  deps: OrchestratorAccountSwitchDeps,
): void {
  if (result.ok || result.requestId !== '' || result.sessionId || !original.accountId) return;
  try {
    const sessions = listAgentSessionsForPane(input.paneId);
    const session = sessions.length === 1 ? sessions[0] : undefined;
    if (!session || session.sessionId !== input.sessionId ||
        session.missionId !== input.missionId || session.role !== 'orchestrator' ||
        session.adapterId !== original.adapterId || session.accountId !== original.accountId ||
        !sameProjectExecutionScope(session.coordinationScope ?? session.scope, input.scope) ||
        !isPtySessionConnectedAndWritable(input.sessionId) ||
        !isDeepStrictEqual(deps.findSpec(input.scope, input.paneId), rebound)) return;
    deps.rebindAccount(input.scope, input.missionId, input.paneId, input.toAccountId, original.accountId);
  } catch {
    // Leitura/compensação indisponível não autoriza adivinhar a conta física.
  }
}

export async function switchRendererOrchestratorAccount(
  input: OrchestratorAccountSwitchInput,
  deps: OrchestratorAccountSwitchDeps = productionDeps,
): Promise<OrchestratorAccountSwitchResult> {
  let spec: MissionPaneSpec | null;
  try {
    spec = deps.findSpec(input.scope, input.paneId);
  } catch {
    spec = null;
  }
  if (
    !spec ||
    spec.missionId !== input.missionId ||
    spec.role !== 'orchestrator'
  ) {
    return { handled: false };
  }
  let rebound: MissionPaneSpec | null;
  try {
    rebound = deps.rebindAccount(
      input.scope,
      input.missionId,
      input.paneId,
      spec.accountId ?? null,
      input.toAccountId,
    );
  } catch {
    rebound = null;
  }
  if (!rebound || rebound.accountId !== input.toAccountId) {
    return {
      handled: true,
      ok: false,
      error: 'a conta selada do orquestrador mudou durante a troca',
    };
  }
  let result: Awaited<ReturnType<typeof requestMissionPaneRecovery>>;
  try {
    result = await deps.requestRecovery({
      missionId: input.missionId,
      paneId: input.paneId,
      role: 'orchestrator',
      expectedSessionId: input.sessionId,
      pane: rebound,
      scope: input.scope,
      recap: input.buildRecap(),
    });
  } catch (error) {
    return {
      handled: true,
      ok: false,
      error: error instanceof Error ? error.message : 'religamento recusado',
    };
  }
  if (!result.ok || !result.sessionId || result.sessionId === input.sessionId) {
    restoreAccountAfterPreflightRefusal(input, spec, rebound, result, deps);
    return {
      handled: true,
      ok: false,
      error: result.error ?? 'o pane não foi religado',
    };
  }
  return { handled: true, ok: true, sessionId: result.sessionId };
}

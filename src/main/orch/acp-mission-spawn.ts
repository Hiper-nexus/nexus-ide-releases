/**
 * ACP transport spawn path for main-owned mission panes.
 *
 * Kept outside main-owned-pane-runtime.ts so the PTY path stays lean. When
 * orch.agentTransport === 'acp', the sync entry refuses PTY fallback and the
 * async entry drives AcpHarnessDriver end-to-end.
 */
import type {
  MissionPaneAuthoritySeal,
  OrchPaneSpawnResult,
  PaneRegistryEntry,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { ACP_ACCOUNT_SELECTION_UNSUPPORTED } from '../../shared/acp-session-config';
import { getOrchSettings } from '../persistence/settings-store';
import { mintToken, releaseSessionByToken } from './gate';
import { visualTaskAtSpawn } from './visual-handoff-gate';
import { getAcpHarness } from '../acp/harness-store';
import { buildAcpMcpStdioServer } from '../acp/acp-mcp-stdio-bridge';
import { makeId } from './store-util';
import { resolveCwdForScope } from './workspace-path';
import { issueAgentIdentityBestEffort } from './agent-identity-spawn';
import type { PaneOrchMeta, PaneSpawnOptions } from './main-owned-pane-runtime';

/** A harness that never answers the spawn handshake is a hang, not a wait. */
const ACP_SPAWN_TIMEOUT_MS = 60_000;

export interface AcpMissionSpawnHooks {
  attachSessionScope(sessionId: string, scope: ProjectExecutionScope): void;
  panesChanged(): void;
}

export function spawnMainOwnedAcpMissionPaneSyncGuard(input: {
  readonly requestId: string;
  readonly paneId: string;
  readonly options: PaneSpawnOptions & {
    missionId: string;
    role: 'orchestrator' | 'worker';
  };
}): OrchPaneSpawnResult {
  const harnessId = getOrchSettings().acpHarnessId.trim();
  if (!harnessId) {
    return {
      requestId: input.requestId,
      ok: false,
      error:
        'transporte ACP selecionado, mas nenhum harness foi escolhido — ' +
        'abra Configurações → Harness e selecione um runtime ACP',
    };
  }
  if (!getAcpHarness(harnessId)) {
    return {
      requestId: input.requestId,
      ok: false,
      error:
        `harness ACP "${harnessId}" não encontrado no catálogo — ` +
        'salve um preset/custom válido antes do spawn',
    };
  }
  return {
    requestId: input.requestId,
    ok: false,
    error:
      `transporte ACP ("${harnessId}") está configurado, mas o caminho de ` +
      'spawn síncrono ainda não faz await do driver ACP. Use ' +
      'spawnMainOwnedAcpMissionPane (async) — sem fallback silencioso para PTY.',
  };
}

export async function spawnMainOwnedAcpMissionPane(
  options: PaneSpawnOptions & {
    missionId: string;
    role: 'orchestrator' | 'worker';
  },
  hooks: AcpMissionSpawnHooks,
  mountPane: (paneId: string, entry: PaneRegistryEntry, meta: PaneOrchMeta) => void,
): Promise<OrchPaneSpawnResult> {
  const requestId = makeId('orchspawn');
  const paneId = makeId('pane');
  if (!options.authoritySeal) {
    return {
      requestId,
      ok: false,
      error: 'mission pane authority seal is unavailable for ACP spawn',
    };
  }
  const orch = getOrchSettings();
  if (orch.agentTransport !== 'acp') {
    return {
      requestId,
      ok: false,
      error:
        "spawnMainOwnedAcpMissionPane requer orch.agentTransport === 'acp'",
    };
  }
  const harnessId = orch.acpHarnessId.trim();
  const harness = harnessId ? getAcpHarness(harnessId) : null;
  if (!harness) {
    return {
      requestId,
      ok: false,
      error:
        harnessId.length === 0
          ? 'nenhum harness ACP selecionado'
          : `harness ACP "${harnessId}" não encontrado`,
    };
  }
  const cwd = resolveCwdForScope(
    options.executionScope ?? options.scope,
    options.cwd,
  );
  // This generic harness path does not project a Nexus account into the
  // harness's effective provider binary. Reject before identity/token effects.
  if (options.accountId !== undefined) {
    return { requestId, ok: false, error: ACP_ACCOUNT_SELECTION_UNSUPPORTED };
  }
  const { getMcpRuntimeInfo } = await import('./mcp-server');
  const mcp = getMcpRuntimeInfo();
  if (!mcp.running || !mcp.url) {
    return {
      requestId,
      ok: false,
      error:
        'o servidor MCP do Nexus ainda não está pronto para o transporte ACP',
    };
  }
  const identityAgentId = options.agentName?.trim() || harness.id;
  let mcpToken: string | undefined;
  try {
    options.assertOriginCurrent?.();
    issueAgentIdentityBestEffort({
      missionId: options.missionId,
      scope: options.scope,
      agentId: identityAgentId,
    });
    const gate = mintToken({
      label: identityAgentId,
      role: options.role,
      missionId: options.missionId,
      contextRevision: options.contextRevision,
      agentName: identityAgentId,
      workerIncarnationId: options.workerIncarnationId,
      providerId: options.adapterId,
      readOnly: options.readOnly === true,
      visualTask: visualTaskAtSpawn(options),
      scope: options.scope,
      executionScope: options.executionScope ?? options.scope,
      allowedTools: options.allowedTools ?? null,
      allowedSkills: options.allowedSkills ?? null,
    });
    mcpToken = gate.token;
    const { spawnAcpHarnessSession } = await import('../acp/acp-harness-driver');
    options.assertOriginCurrent?.();
    const spawnPromise = spawnAcpHarnessSession({
      harness,
      cwd,
      paneId,
      missionId: options.missionId,
      scope: options.scope,
      adapterId: options.adapterId,
      role: options.role,
      workerIncarnationId: options.workerIncarnationId,
      mcpToken,
      operatorOpened: options.operatorOpened,
      mcpServers: [buildAcpMcpStdioServer(mcp.url, mcpToken)],
      model: options.model,
      accountId: options.accountId,
      effort: options.effort,
      agentName: identityAgentId,
      readOnly: options.readOnly,
      nativeReadOnly: options.nativeReadOnly,
      allowedTools: options.allowedTools,
      allowedSkills: options.allowedSkills,
      authoritySeal: options.authoritySeal,
    });
    // A harness that never answers must not strand the mission flight: the
    // timeout converts the hang into a retryable spawn_failed, and a session
    // that finally arrives late is shut down so no process leaks.
    let spawnTimer: ReturnType<typeof setTimeout> | undefined;
    const spawnTimeout = new Promise<never>((_, reject) => {
      spawnTimer = setTimeout(
        () =>
          reject(
            new Error(
              'o harness ACP não respondeu ao spawn em 60s (spawn_failed)',
            ),
          ),
        ACP_SPAWN_TIMEOUT_MS,
      );
    });
    let session: Awaited<ReturnType<typeof spawnAcpHarnessSession>>;
    try {
      session = await Promise.race([spawnPromise, spawnTimeout]);
    } catch (error) {
      clearTimeout(spawnTimer);
      void spawnPromise
        .then((late) => late.shutdown())
        .catch(() => undefined);
      throw error;
    }
    clearTimeout(spawnTimer);
    if (options.initialPrompt && options.initialPrompt.trim().length > 0) {
      void session.prompt(options.initialPrompt).catch(() => {
        /* turn failure already framed by the driver */
      });
    }
    hooks.attachSessionScope(session.sessionId, options.scope);
    const authoritySeal: MissionPaneAuthoritySeal = Object.freeze({
      ...options.authoritySeal,
    });
    mountPane(
      paneId,
      {
        paneId,
        sessionId: session.sessionId,
        title: options.title ?? options.agentName ?? harness.label,
        kind: 'cli-agent',
        adapterId: options.adapterId,
        model: options.model,
        accountId: options.accountId,
        state: 'spawning',
      },
      {
        missionId: options.missionId,
        contextRevision: options.contextRevision,
        agentName: options.agentName,
        workerIncarnationId: options.workerIncarnationId,
        allowedTools: options.allowedTools,
        allowedSkills: options.allowedSkills,
        role: options.role,
        transient: options.transient === true ? true : undefined,
        scope: options.scope,
        executionScope: options.executionScope ?? options.scope,
        readOnly: options.readOnly === true,
        nativeReadOnly: options.nativeReadOnly === true,
        authoritySeal,
      },
    );
    hooks.panesChanged();
    return {
      requestId,
      ok: true,
      paneId,
      sessionId: session.sessionId,
    };
  } catch (error) {
    if (mcpToken) releaseSessionByToken(mcpToken);
    return {
      requestId,
      ok: false,
      error:
        error instanceof Error ? error.message : 'ACP harness spawn failed',
    };
  }
}

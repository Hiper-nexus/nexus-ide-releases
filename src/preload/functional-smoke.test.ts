import { describe, expect, it, vi } from 'vitest';
import type {
  MissionPrepareRequest,
  MissionReview,
} from '../shared/mission-engine-contract';
import {
  FUNCTIONAL_SMOKE_FILE_CONTENT,
  FUNCTIONAL_SMOKE_MIN_ADAPTERS,
  FUNCTIONAL_SMOKE_MIN_TOOLS,
  runFunctionalSmokeProbes,
  type FunctionalSmokeApi,
} from './functional-smoke';

const FUNCTIONAL_SMOKE_REVIEW_SHA256 = 'a'.repeat(64);

function successfulMissionReview(
  request: MissionPrepareRequest,
): MissionReview {
  return {
    missionId: 'mission-smoke-1',
    title: request.title ?? request.objective,
    objective: request.objective,
    workspaceLabel: 'nexus-smoke-workspace',
    contextPaths: [...request.contextPaths],
    roster: request.roster.map((agent) => ({
      ...agent,
      allowedSkills: agent.allowedSkills
        ? [...agent.allowedSkills]
        : agent.allowedSkills,
      allowedTools: agent.allowedTools
        ? [...agent.allowedTools]
        : agent.allowedTools,
    })),
    permissions: [
      {
        id: 'workspace-read',
        label: 'Ler arquivos do projeto',
        detail: 'Somente o projeto selecionado e os contextos aprovados.',
      },
      {
        id: 'workspace-write',
        label: 'Alterar arquivos do projeto',
        detail: 'Somente dentro da pasta selecionada e dos worktrees da missão.',
      },
      {
        id: 'local-commands',
        label: 'Executar comandos locais',
        detail:
          'Sob sandbox, orçamento e ferramentas aprovadas para cada papel.',
      },
    ],
    warnings: [],
    reviewSha256: FUNCTIONAL_SMOKE_REVIEW_SHA256,
    createdAt: 1,
  };
}


function successfulApi(): FunctionalSmokeApi {
  return {
    workspace: {
      open: vi.fn(async (workspacePath: string) => ({
        current: { path: workspacePath, name: 'smoke', lastOpenedAt: 1 },
        recents: [],
      })),
    },
    adapters: {
      list: vi.fn(async () =>
        Array.from({ length: FUNCTIONAL_SMOKE_MIN_ADAPTERS }, (_, index) => ({
          id: `adapter-${index}`,
        }))),
    },
    settings: {
      get: vi.fn(async () => ({})),
      orchGet: vi.fn(async () => ({})),
      audioGet: vi.fn(async () => ({})),
      uiGet: vi.fn(async () => ({})),
      listShells: vi.fn(async () => ['/bin/zsh']),
    },
    providers: { list: vi.fn(async () => [{ adapterId: 'claude' }]) },
    voice: { getInfo: vi.fn(async () => ({ routing: 'jarvis' })) },
    mission: {
      prepare: vi.fn(async (request: MissionPrepareRequest) =>
        successfulMissionReview(request),
      ),
    },
    orch: {
      getMcpInfo: vi.fn(async () => ({
        running: true,
        url: 'http://127.0.0.1:62000/mcp',
        toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
      })),
      listMissions: vi.fn(async () => []),
      listSquads: vi.fn(async () => []),
      listMissionPanes: vi.fn(async () => []),
      // Sessão de shell plana NÃO tem missão: a lane do operador recusa.
      sendPaneOperatorInput: vi.fn(async () => false),
    },
    pty: (() => {
      const listeners = new Map<string, (data: string) => void>();
      const exitListeners = new Map<
        string,
        (info: { exitCode: number; signal?: number }) => void
      >();
      return {
        spawn: vi.fn(async () => ({ ok: true, sessionId: 'pty-smoke-1' })),
        writeConfirmed: vi.fn(async (sessionId: string, data: string) => {
          if (sessionId !== 'pty-smoke-1') return false;
          // Eco do TTY: o texto digitado volta pelo stream de dados.
          queueMicrotask(() => listeners.get(sessionId)?.(data));
          return true;
        }),
        kill: vi.fn((sessionId: string) => {
          queueMicrotask(() => exitListeners.get(sessionId)?.({ exitCode: 0 }));
        }),
        onData: vi.fn((sessionId: string, cb: (data: string) => void) => {
          listeners.set(sessionId, cb);
          return () => listeners.delete(sessionId);
        }),
        onExit: vi.fn(
          (
            sessionId: string,
            cb: (info: { exitCode: number; signal?: number }) => void,
          ) => {
            exitListeners.set(sessionId, cb);
            return () => exitListeners.delete(sessionId);
          },
        ),
      };
    })(),
    mcp: {
      invoke: vi.fn(async (tool: string) => {
        if (tool === 'nexus_file_read') {
          return {
            ok: true,
            tool,
            result: { path: 'smoke.txt', content: FUNCTIONAL_SMOKE_FILE_CONTENT },
          };
        }
        if (tool === 'nexus_file_write') {
          return { ok: false, tool, requiredConfirmation: true };
        }
        if (tool === 'nexus_ui_read') {
          return { ok: true, tool, result: { surface: 'nexus-ui', text: 'NexusIDE' } };
        }
        return { ok: true, tool, result: {} };
      }),
    },
    media: { listProviders: vi.fn(async () => []) },
    perf: { snapshot: vi.fn(async () => ({ at: 1 })) },
    update: { getState: vi.fn(async () => ({ phase: 'idle' })) },
    product: {
      flagsList: vi.fn(async () => [
        {
          id: 'feature.search.mixer',
          enabled: true,
          reason: 'default',
          definition: { id: 'feature.search.mixer', killSwitch: false },
        },
        {
          id: 'feature.mission.eventJournal',
          enabled: true,
          reason: 'default',
          definition: { id: 'feature.mission.eventJournal', killSwitch: false },
        },
        {
          id: 'feature.mcp.hub',
          enabled: true,
          reason: 'default',
          definition: { id: 'feature.mcp.hub', killSwitch: false },
        },
        {
          id: 'feature.memory.nexusMemory',
          enabled: true,
          reason: 'default',
          definition: { id: 'feature.memory.nexusMemory', killSwitch: false },
        },
        {
          id: 'feature.skills.catalog',
          enabled: true,
          reason: 'default',
          definition: { id: 'feature.skills.catalog', killSwitch: false },
        },
      ]),
      searchQuery: vi.fn(async () => ({
        generation: 1,
        query: 'smoke',
        hits: [],
        partial: false,
        completedSources: [],
        cancelled: false,
        elapsedMs: 1,
      })),
    },
  };
}

describe('runFunctionalSmokeProbes', () => {
  it('proves the packaged preload-to-main IPC and audited MCP path', async () => {
    const api = successfulApi();

    const result = await runFunctionalSmokeProbes(api, '/tmp/nexus-smoke-workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected failure: ${result.failedProbe}`);
    expect(result.toolCount).toBe(FUNCTIONAL_SMOKE_MIN_TOOLS);
    expect(result.adapterCount).toBe(FUNCTIONAL_SMOKE_MIN_ADAPTERS);
    expect(result.probes).toContain('mission-prepare');
    expect(result.probes).toContain('product-flags');
    expect(result.probes).toContain('search-mixer-ipc');
    expect(result.probes).toContain('mcp-ui-read');
    expect(result.probes).toContain('mcp-file-read');
    expect(result.probes).toContain('mcp-write-guard');
    expect(api.workspace.open).toHaveBeenCalledWith('/tmp/nexus-smoke-workspace');
    expect(api.mission.prepare).toHaveBeenCalledWith({
      objective:
        'Verify canonical mission preparation without starting any workers.',
      title: 'Functional smoke: canonical mission preparation',
      contextPaths: [],
      roster: [
        {
          id: 'functional-smoke-orchestrator',
          agentName: 'Functional Smoke Orchestrator',
          category: 'orchestrator',
          cli: 'codex',
          allowedSkills: [],
          allowedTools: [],
        },
        {
          id: 'functional-smoke-executor',
          agentName: 'Functional Smoke Executor',
          category: 'executor',
          cli: 'codex',
          allowedSkills: [],
          allowedTools: [],
        },
        {
          id: 'functional-smoke-reviewer',
          agentName: 'Functional Smoke Reviewer',
          category: 'reviewer',
          cli: 'codex',
          allowedSkills: [],
          allowedTools: [],
        },
      ],
      advanced: { lane: 'standard' },
    });
    expect(api.orch.listMissionPanes).toHaveBeenCalledWith('mission-smoke-1');
    expect(api.product.flagsList).toHaveBeenCalled();
    expect(api.mcp.invoke).toHaveBeenCalledWith('nexus_file_read', { path: 'smoke.txt' });
  });

  it.each([
    [
      'request identity',
      (review: MissionReview) => ({
        ...review,
        title: 'A different prepared mission',
      }),
    ],
    [
      'review SHA-256',
      (review: MissionReview) => ({
        ...review,
        reviewSha256: 'not-a-review-hash',
      }),
    ],
    [
      'standard permissions',
      (review: MissionReview) => ({
        ...review,
        permissions: [],
      }),
    ],
  ] as const)(
    'fails closed when mission.prepare returns invalid %s',
    async (_caseName, corruptReview) => {
      const api = successfulApi();
      vi.mocked(api.mission.prepare).mockImplementation(async (request) =>
        corruptReview(successfulMissionReview(request)),
      );

      const result = await runFunctionalSmokeProbes(api, '/tmp/workspace', {
        delay: async () => {},
        probeTimeoutMs: 100,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected mission-prepare probe to fail');
      expect(result.failedProbe).toBe('mission-prepare');
      expect(api.orch.listMissionPanes).not.toHaveBeenCalled();
    },
  );

  it('fails when mission.prepare creates any pane', async () => {
    const api = successfulApi();
    vi.mocked(api.orch.listMissionPanes).mockResolvedValue([
      { id: 'unexpected-pane' },
    ]);

    const result = await runFunctionalSmokeProbes(api, '/tmp/workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected mission-prepare probe to fail');
    expect(result.failedProbe).toBe('mission-prepare');
  });

  it('waits for the embedded MCP server instead of racing app bootstrap', async () => {
    const api = successfulApi();
    const getMcpInfo = vi.mocked(api.orch.getMcpInfo);
    getMcpInfo
      .mockResolvedValueOnce({ running: false, url: null, toolCount: 0 })
      .mockResolvedValueOnce({
        running: true,
        url: 'http://127.0.0.1:62000/mcp',
        toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
      });
    const delay = vi.fn(async () => {});

    const result = await runFunctionalSmokeProbes(api, '/tmp/workspace', {
      delay,
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    expect(delay).toHaveBeenCalledOnce();
    expect(getMcpInfo).toHaveBeenCalledTimes(2);
  });

  it('accepts the PREVC mission-authority guard as stronger write protection', async () => {
    const api = successfulApi();
    const invoke = vi.mocked(api.mcp.invoke);
    invoke.mockImplementation(async (tool: string) => {
      if (tool === 'nexus_file_write') {
        return {
          ok: false,
          tool,
          denied: true,
          error:
            'mission effect blocked: projectId, checkoutId, missionId and contextRevision are required',
        };
      }
      if (tool === 'nexus_file_read') {
        return {
          ok: true,
          tool,
          result: { path: 'smoke.txt', content: FUNCTIONAL_SMOKE_FILE_CONTENT },
        };
      }
      if (tool === 'nexus_ui_read') {
        return { ok: true, tool, result: { surface: 'nexus-ui' } };
      }
      return { ok: true, tool, result: {} };
    });

    const result = await runFunctionalSmokeProbes(api, '/tmp/workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(true);
  });

  it('fails closed when the packaged adapter registry is incomplete', async () => {
    const api = successfulApi();
    vi.mocked(api.adapters.list).mockResolvedValue([]);

    const result = await runFunctionalSmokeProbes(api, '/tmp/workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      probes: ['workspace-open'],
      failedProbe: 'adapter-registry',
    });
  });

  it('fails if a mutating MCP tool bypasses its confirmation guard', async () => {
    const api = successfulApi();
    vi.mocked(api.mcp.invoke).mockImplementation(async (tool: string) => ({
      ok: true,
      tool,
      result:
        tool === 'nexus_file_read'
          ? { path: 'smoke.txt', content: FUNCTIONAL_SMOKE_FILE_CONTENT }
          : tool === 'nexus_ui_read'
            ? { surface: 'nexus-ui' }
            : {},
    }));

    const result = await runFunctionalSmokeProbes(api, '/tmp/workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the write guard probe to fail');
    expect(result.failedProbe).toBe('mcp-write-guard');
  });

  it('returns only a bounded probe identifier when an IPC call throws', async () => {
    const api = successfulApi();
    vi.mocked(api.voice.getInfo).mockRejectedValue(
      new Error('secret provider output that must not cross the smoke boundary'),
    );

    const result = await runFunctionalSmokeProbes(api, '/tmp/workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the voice runtime probe to fail');
    expect(result.failedProbe).toBe('voice-runtime');
    expect(JSON.stringify(result)).not.toContain('secret provider output');
  });
});

describe('runFunctionalSmokeProbes — ditado obrigatório no smoke empacotado', () => {
  it('prova entrega real no PTY e recusas de autoridade das duas lanes', async () => {
    const api = successfulApi();

    const result = await runFunctionalSmokeProbes(api, '/tmp/nexus-smoke-workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.probes).toContain('dictation-delivery');
    expect(result.probes).toContain('dictation-governed-lane');
    expect(api.pty.writeConfirmed).toHaveBeenCalledWith(
      'pty-smoke-1',
      'nexus-dictation-smoke-marker',
    );
    expect(api.orch.sendPaneOperatorInput).toHaveBeenCalledWith({
      sessionId: 'pty-smoke-1',
      data: 'nexus-smoke',
    });
    expect(api.pty.kill).toHaveBeenCalledWith('pty-smoke-1');
  });

  it('falha quando o PTY aceita a escrita mas o texto nunca ecoa (entrega morta)', async () => {
    const api = successfulApi();
    api.pty.writeConfirmed = vi.fn(async (sessionId: string) =>
      sessionId === 'pty-smoke-1',
    );

    const result = await runFunctionalSmokeProbes(api, '/tmp/nexus-smoke-workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('esperava falha');
    expect(result.failedProbe).toBe('dictation-delivery');
  });

  it('falha quando a lane do operador aceita sessão sem missão (gate morto)', async () => {
    const api = successfulApi();
    api.orch.sendPaneOperatorInput = vi.fn(async () => true);

    const result = await runFunctionalSmokeProbes(api, '/tmp/nexus-smoke-workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('esperava falha');
    expect(result.failedProbe).toBe('dictation-governed-lane');
  });
});

describe('runFunctionalSmokeProbes — Space hold-to-talk no smoke empacotado', () => {
  it('prova o contrato do discriminador e a entrega física do espaço do toque', async () => {
    const api = successfulApi();

    const result = await runFunctionalSmokeProbes(api, '/tmp/nexus-smoke-workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.probes).toContain('dictation-hold-to-talk');
    // O espaço retido pelo toque é ENTREGUE de verdade no PTY empacotado.
    // O espaço viaja entre dois tokens únicos: um ' ' solto no scrollback
    // daria falso-verde no primeiro repaint de prompt do shell.
    expect(api.pty.writeConfirmed).toHaveBeenCalledWith(
      'pty-smoke-1',
      'nexus-tap space-marker',
    );
  });

  it('falha se o toque armar ditado (a regressão exata da v0.26.0)', async () => {
    const api = successfulApi();

    const result = await runFunctionalSmokeProbes(api, '/tmp/nexus-smoke-workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
      // Simula o discriminador quebrado: keydown arma na hora, sem limiar.
      holdToTalkFactory: () => ({
        keyDown: () => ({
          suppressKey: true,
          startDictation: true,
          stopDictation: false,
          emitSpaces: 0,
          armThreshold: false,
        }),
        thresholdElapsed: () => ({
          suppressKey: false,
          startDictation: false,
          stopDictation: false,
          emitSpaces: 0,
          armThreshold: false,
        }),
        keyUp: () => ({
          suppressKey: true,
          startDictation: false,
          stopDictation: true,
          emitSpaces: 0,
          armThreshold: false,
        }),
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('esperava falha');
    expect(result.failedProbe).toBe('dictation-hold-to-talk');
  });

  it('falha se o espaço do toque não chegar ao pane (tecla engolida)', async () => {
    const api = successfulApi();
    const realWrite = api.pty.writeConfirmed;
    api.pty.writeConfirmed = vi.fn(async (sessionId: string, data: string) => {
      // Aceita tudo menos o espaço — exatamente o sintoma do usuário.
      if (data.includes('nexus-tap')) return false;
      return realWrite(sessionId, data);
    });

    const result = await runFunctionalSmokeProbes(api, '/tmp/nexus-smoke-workspace', {
      delay: async () => {},
      probeTimeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('esperava falha');
    expect(result.failedProbe).toBe('dictation-hold-to-talk');
  });
});

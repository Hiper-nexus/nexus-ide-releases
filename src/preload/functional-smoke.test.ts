import { describe, expect, it, vi } from 'vitest';
import {
  FUNCTIONAL_SMOKE_FILE_CONTENT,
  FUNCTIONAL_SMOKE_MIN_ADAPTERS,
  FUNCTIONAL_SMOKE_MIN_TOOLS,
  runFunctionalSmokeProbes,
  type FunctionalSmokeApi,
} from './functional-smoke';

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
    orch: {
      getMcpInfo: vi.fn(async () => ({
        running: true,
        url: 'http://127.0.0.1:62000/mcp',
        toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
      })),
      listMissions: vi.fn(async () => []),
      listSquads: vi.fn(async () => []),
    },
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
    expect(result.probes).toContain('mcp-ui-read');
    expect(result.probes).toContain('mcp-file-read');
    expect(result.probes).toContain('mcp-write-guard');
    expect(api.workspace.open).toHaveBeenCalledWith('/tmp/nexus-smoke-workspace');
    expect(api.mcp.invoke).toHaveBeenCalledWith('nexus_file_read', { path: 'smoke.txt' });
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

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  type OmpRpcPushEvent,
} from '../../shared/omp-rpc-types';
import {
  OmpRpcSession,
  type OmpAutoApprovalRecord,
  type OmpChildLike,
  type OmpRpcSessionDeps,
} from './omp-rpc-service';

/**
 * Testes do serviço OmpRpcSession com um processo FAKE (EventEmitter):
 * nenhum spawn real. Frames de exemplo copiados de docs/rpc.md do
 * can1357/oh-my-pi@03c48d073.
 */

class FakeOmpProcess implements OmpChildLike {
  private readonly emitter = new EventEmitter();
  /** Linhas NDJSON escritas pelo host no stdin, já parseadas quando JSON. */
  readonly written: string[] = [];
  readonly kills: string[] = [];
  pid = 4242;

  stdin = {
    write: (data: string) => {
      this.written.push(...data.split('\n').filter(Boolean));
      return true;
    },
  };

  stdout = {
    on: (event: 'data', cb: (chunk: Buffer | string) => void) => {
      this.emitter.on(`stdout:${event}`, cb);
      return this;
    },
  };

  stderr = {
    on: (event: 'data', cb: (chunk: Buffer | string) => void) => {
      this.emitter.on(`stderr:${event}`, cb);
      return this;
    },
  };

  on(event: 'exit' | 'error', cb: (arg: never) => void): this {
    this.emitter.on(event, cb as (...args: unknown[]) => void);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }

  /** Emite bytes crus no stdout (pode conter frames parciais/inválidos). */
  emitStdout(raw: string): void {
    this.emitter.emit('stdout:data', raw);
  }

  /** Emite um Buffer cru — usado para simular boundary de chunk em multibyte. */
  emitStdoutBytes(bytes: Buffer): void {
    this.emitter.emit('stdout:data', bytes);
  }

  /** Emite um frame JSON completo com o \n do protocolo. */
  emitFrame(frame: object): void {
    this.emitStdout(`${JSON.stringify(frame)}\n`);
  }

  exit(code: number | null): void {
    this.emitter.emit('exit', code);
  }

  /** Última linha JSON escrita no stdin com o type pedido. */
  lastWritten(type: string): Record<string, unknown> | undefined {
    for (let i = this.written.length - 1; i >= 0; i -= 1) {
      const parsed = JSON.parse(this.written[i]) as Record<string, unknown>;
      if (parsed.type === type) return parsed;
    }
    return undefined;
  }
}

interface Harness {
  proc: FakeOmpProcess;
  session: OmpRpcSession;
  pushes: OmpRpcPushEvent[];
  dispatched: Array<{ toolName: string; args: Record<string, unknown> }>;
  audits: OmpAutoApprovalRecord[];
  deps: OmpRpcSessionDeps;
}

function createHarness(
  overrides: Partial<OmpRpcSessionDeps> & {
    approvalPolicy?: 'yolo' | 'safe';
  } = {},
): Harness {
  const proc = new FakeOmpProcess();
  const pushes: OmpRpcPushEvent[] = [];
  const dispatched: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const audits: OmpAutoApprovalRecord[] = [];
  const deps: OmpRpcSessionDeps = {
    hostTools: [
      {
        name: 'nexus_pane_list',
        description: 'List panes',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'nexus_mission_get',
        description: 'Get a mission by id.',
        parameters: {
          type: 'object',
          properties: { missionId: { type: 'string' } },
          required: ['missionId'],
        },
      },
      {
        name: 'nexus_handoff_submit',
        description: 'Submit handoff',
        parameters: { type: 'object', properties: {} },
      },
    ],
    dispatchHostTool: async (toolName, args) => {
      dispatched.push({ toolName, args });
      return { ok: true, result: { panes: [] } };
    },
    auditAutoApproval: (record) => {
      audits.push(record);
    },
    onPush: (event) => {
      pushes.push(event);
    },
    spawnImpl: () => proc,
    requestTimeoutMs: 500,
    uiResponseTimeoutMs: 200,
    killGraceMs: 50,
    ...overrides,
  };
  const session = new OmpRpcSession(
    {
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/workspace',
      approvalPolicy: overrides.approvalPolicy ?? 'yolo',
      binPath: '/usr/local/bin/omp',
    },
    deps,
  );
  return { proc, session, pushes, dispatched, audits, deps };
}

/** Handshake padrão: ready + drena o bootstrap (set_host_tools/get_state). */
async function becomeIdle(harness: Harness): Promise<void> {
  const { proc } = harness;
  proc.emitFrame({ type: 'ready' });
  await Promise.resolve();
  const hostTools = proc.lastWritten('set_host_tools');
  expect(hostTools).toBeDefined();
  proc.emitFrame({
    id: hostTools?.id,
    type: 'response',
    command: 'set_host_tools',
    success: true,
    data: {
      toolNames: ['nexus_pane_list', 'nexus_mission_get', 'nexus_handoff_submit'],
    },
  });
  await vi.waitFor(() => {
    expect(proc.lastWritten('get_state')).toBeDefined();
  });
  const getState = proc.lastWritten('get_state');
  proc.emitFrame({
    id: getState?.id,
    type: 'response',
    command: 'get_state',
    success: true,
    // Payload de get_state conforme docs/rpc.md (reduzido aos campos usados).
    data: {
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      thinkingLevel: 'medium',
      isStreaming: false,
      isCompacting: false,
      sessionId: 'omp-internal-1',
      sessionName: 'B1',
      contextUsage: { tokens: 1100, contextWindow: 200000, percent: 0.55 },
    },
  });
  await vi.waitFor(() => {
    expect(harness.session.state).toBe('idle');
  });
}


describe('host_tool_call → dispatcher com gate', () => {
  it('roteia pelo dispatcher injetado e devolve host_tool_result', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'host_tool_call',
      id: 'host_1',
      toolCallId: 'toolu_123',
      toolName: 'nexus_pane_list',
      arguments: {},
    });
    await vi.waitFor(() => {
      expect(harness.proc.lastWritten('host_tool_result')).toBeDefined();
    });
    expect(harness.dispatched).toEqual([{ toolName: 'nexus_pane_list', args: {} }]);
    const result = harness.proc.lastWritten('host_tool_result');
    expect(result).toMatchObject({ id: 'host_1' });
    expect(result?.isError).toBeUndefined();
    const content = (result?.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toContain('panes');
  });

  it('negação do gate volta como isError sem bypass', async () => {
    const harness = createHarness({
      dispatchHostTool: async () => ({
        ok: false,
        error: 'tool "nexus_pane_list" is outside this agent\'s allowlist',
      }),
    });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'host_tool_call',
      id: 'host_2',
      toolCallId: 'toolu_124',
      toolName: 'nexus_pane_list',
      arguments: {},
    });
    await vi.waitFor(() => {
      expect(harness.proc.lastWritten('host_tool_result')).toMatchObject({
        id: 'host_2',
        isError: true,
      });
    });
  });

  it('tool fora do set anunciado é recusada sem tocar o dispatcher', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'host_tool_call',
      id: 'host_3',
      toolCallId: 'toolu_125',
      toolName: 'nexus_git_push',
      arguments: {},
    });
    await vi.waitFor(() => {
      expect(harness.proc.lastWritten('host_tool_result')).toMatchObject({
        id: 'host_3',
        isError: true,
      });
    });
    expect(harness.dispatched).toHaveLength(0);
  });

  it('host_tool_cancel suprime o resultado tardio', async () => {
    let release: (() => void) | null = null;
    const harness = createHarness({
      dispatchHostTool: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, result: 'late' });
        }),
    });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'host_tool_call',
      id: 'host_4',
      toolCallId: 'toolu_126',
      toolName: 'nexus_pane_list',
      arguments: {},
    });
    harness.proc.emitFrame({
      type: 'host_tool_cancel',
      id: 'host_cancel_1',
      targetId: 'host_4',
    });
    await vi.waitFor(() => {
      expect(release).not.toBeNull();
    });
    release!();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.proc.lastWritten('host_tool_result')).toBeUndefined();
  });
});

describe('robustez do parser NDJSON', () => {
  it('linha malformada é ignorada sem derrubar a sessão', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const harness = createHarness();
      harness.proc.emitStdout('{esto não é json}\n');
      harness.proc.emitFrame({ type: 'ready' });
      await Promise.resolve();
      expect(harness.session.state).not.toBe('exited');
      expect(harness.proc.lastWritten('set_host_tools')).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('frames divididos entre chunks são remontados', async () => {
    const harness = createHarness();
    const frame = JSON.stringify({ type: 'ready' });
    harness.proc.emitStdout(frame.slice(0, 5));
    harness.proc.emitStdout(`${frame.slice(5)}\n`);
    await Promise.resolve();
    expect(harness.session.state).not.toBe('spawning');
  });

  it('frame com type desconhecido é ignorado por contrato', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    harness.proc.emitFrame({ type: 'subagent_progress', payload: {} });
    expect(harness.session.state).toBe('idle');
  });

  it('UTF-8 multibyte partido entre Buffers é remontado sem U+FFFD', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    // Frame com pt-BR + emoji; parte os bytes no meio do 🚀 (F0 9F 9A 80).
    const frame = `${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'café 🚀 ação' },
    })}\n`;
    const bytes = Buffer.from(frame, 'utf8');
    const rocket = Buffer.from('🚀', 'utf8');
    const cut = bytes.indexOf(rocket) + 2; // no meio dos 4 bytes do emoji
    harness.proc.emitStdoutBytes(bytes.subarray(0, cut));
    harness.proc.emitStdoutBytes(bytes.subarray(cut));
    await Promise.resolve();
    const textPush = harness.pushes.find(
      (p) =>
        p.kind === 'text-delta' && String(p.delta ?? '').includes('café'),
    ) as { kind: 'text-delta'; delta: string } | undefined;
    expect(textPush).toBeDefined();
    expect(textPush?.delta).toBe('café 🚀 ação');
    expect(textPush?.delta).not.toContain('�');
  });
});

describe('dispose e saída do processo', () => {
  it('dispose envia SIGTERM e escala para SIGKILL após o grace', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ killGraceMs: 50 });
      harness.proc.emitFrame({ type: 'ready' });
      harness.session.dispose();
      expect(harness.proc.kills).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(60);
      expect(harness.proc.kills).toEqual(['SIGTERM', 'SIGKILL']);
      harness.proc.exit(137);
      expect(harness.session.state).toBe('exited');
    } finally {
      vi.useRealTimers();
    }
  });

  it('exit rejeita comandos pendentes e emite push de exit', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    const pendingPrompt = harness.session.prompt('nunca respondido');
    harness.proc.exit(0);
    await expect(pendingPrompt).rejects.toThrow(/encerrou/);
    expect(harness.session.state).toBe('exited');
    expect(harness.pushes.at(-1)).toEqual({ kind: 'exit', code: 0 });
  });

  it('dispose após exit não re-mata o processo', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    harness.proc.exit(0);
    harness.session.dispose();
    expect(harness.proc.kills).toHaveLength(0);
  });
});

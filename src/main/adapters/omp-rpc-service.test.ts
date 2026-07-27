import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  ompExtensionUiRequestSchema,
  ompHostToolCallFrameSchema,
  ompResponseFrameSchema,
  ompSessionStateSchema,
  type OmpRpcPushEvent,
} from '../../shared/omp-rpc-types';
import {
  OMP_RPC_MAX_FRAME_CHARS,
  OMP_RPC_MAX_PENDING_UI,
  OmpRpcSession,
  buildOmpChildEnv,
  clearOmpBinCache,
  ompControlArgs,
  resolveOmpBin,
  waitForOmpSessionReady,
  type OmpAutoApprovalRecord,
  type OmpChildLike,
  type OmpRpcSessionConfig,
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
  pid: number | undefined;

  constructor(pid: number | undefined) {
    this.pid = pid;
  }

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

  emitStderr(raw: string): void {
    this.emitter.emit('stderr:data', raw);
  }

  /** Emite um frame JSON completo com o \n do protocolo. */
  emitFrame(frame: object): void {
    this.emitStdout(`${JSON.stringify(frame)}\n`);
  }

  exit(code: number | null): void {
    this.emitter.emit('exit', code);
  }

  fail(error: Error): void {
    this.emitter.emit('error', error);
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
    /** null models Node spawn failure before a PID is allocated. */
    processPid?: number | null;
    sessionConfig?: Partial<
      Pick<OmpRpcSessionConfig, 'env' | 'credentialSecrets'>
    >;
  } = {},
): Harness {
  const {
    approvalPolicy,
    processPid,
    sessionConfig,
    ...dependencyOverrides
  } = overrides;
  const proc = new FakeOmpProcess(
    processPid === null ? undefined : (processPid ?? 4242),
  );
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
    processInventoryIntervalMs: 30_000,
    captureProcessTree: async (rootPid) => ({
      root: {
        pid: rootPid,
        ppid: 1,
        pgid: rootPid,
        sid: rootPid,
        tty: '??',
        startedAt: 'Mon Jan  1 00:00:00 2024',
      },
      descendants: [],
      inventory: [
        {
          pid: rootPid,
          ppid: 1,
          pgid: rootPid,
          sid: rootPid,
          tty: '??',
          startedAt: 'Mon Jan  1 00:00:00 2024',
        },
      ],
      capturedAtMs: Date.UTC(2025, 0, 1),
    }),
    terminateProcessTree: async (input) => {
      input.killRoot('SIGTERM');
      return {
        ok: false,
        rootExited: false,
        descendantsExited: false,
        error: 'fake root has not emitted exit',
      };
    },
    ...dependencyOverrides,
  };
  const session = new OmpRpcSession(
    {
      sessionId: 'sess-1',
      workspaceRoot: '/tmp/workspace',
      approvalPolicy: approvalPolicy ?? 'yolo',
      binPath: '/usr/local/bin/omp',
      ...sessionConfig,
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

describe('schemas zod × frames reais do docs/rpc.md', () => {
  it('valida response de prompt (ack imediato)', () => {
    const frame = ompResponseFrameSchema.parse({
      id: 'req_1',
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: false },
    });
    expect(frame.command).toBe('prompt');
  });

  it('valida o payload de get_state', () => {
    const state = ompSessionStateSchema.parse({
      model: { provider: 'x', id: 'y' },
      thinkingLevel: 'high',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      interruptMode: 'immediate',
      sessionId: 's',
      autoCompactionEnabled: true,
      messageCount: 0,
      queuedMessageCount: 0,
      todoPhases: [],
      contextUsage: { tokens: 1100, contextWindow: 200000, percent: 0.55 },
    });
    expect(state.contextUsage?.percent).toBe(0.55);
  });

  it('valida extension_ui_request de confirm e host_tool_call', () => {
    const confirm = ompExtensionUiRequestSchema.parse({
      type: 'extension_ui_request',
      id: '123',
      method: 'confirm',
      title: 'Confirm',
      message: 'Continue?',
      timeout: 30000,
    });
    expect(confirm.method).toBe('confirm');
    const call = ompHostToolCallFrameSchema.parse({
      type: 'host_tool_call',
      id: 'host_1',
      toolCallId: 'toolu_123',
      toolName: 'echo_host',
      arguments: { message: 'hello' },
    });
    expect(call.arguments.message).toBe('hello');
  });
});

describe('argv e env do spawn', () => {
  it('liga rpc-ui e mantém aprovações no host (always-ask)', () => {
    expect(ompControlArgs()).toEqual([
      '--mode',
      'rpc-ui',
      '--approval-mode',
      'always-ask',
    ]);
  });

  it('isola extensões, regras e skills externas somente no worker governado', () => {
    expect(ompControlArgs(true)).toEqual([
      '--mode',
      'rpc-ui',
      '--approval-mode',
      'always-ask',
      '--no-extensions',
      '--no-rules',
      '--tools=read,bash,edit,ast_grep,ast_edit,ask,debug,eval,github,glob,grep,lsp,inspect_image,browser,checkpoint,rewind,hub,todo,web_search,write,memory_edit,retain,recall,reflect,learn,manage_skill,yield,goal',
      '--no-skills',
    ]);
    expect(ompControlArgs(false)).not.toContain('--no-skills');
    expect(ompControlArgs(false).some((arg) => arg.startsWith('--tools='))).toBe(
      false,
    );
    const governedTools = ompControlArgs(true)
      .find((arg) => arg.startsWith('--tools='))
      ?.slice('--tools='.length)
      .split(',');
    expect(governedTools).toBeDefined();
    expect(governedTools).not.toContain('task');
  });

  it('env do filho é allowlist (sem segredos de outros adapters)', () => {
    const env = buildOmpChildEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      ANTHROPIC_API_KEY: 'sk-secreto',
      LC_ALL: 'pt_BR.UTF-8',
    } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LC_ALL).toBe('pt_BR.UTF-8');
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });
});

describe('resolveOmpBin', () => {
  beforeEach(() => {
    clearOmpBinCache();
  });

  it('valida a versão pinada via omp --version', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === '--version') cb(null, 'omp/17.0.4\n');
        else cb(null, '/opt/homebrew/bin/omp\n');
      },
    );
    const resolved = await resolveOmpBin('omp', exec as never);
    expect(resolved.binPath).toBe('/opt/homebrew/bin/omp');
    expect(resolved.version).toBe('17.0.4');
  });

  it('recusa versão diferente mesmo dentro do major 17 com CTA PT-BR', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        cb(null, args[0] === '--version' ? 'omp/17.0.5\n' : '/x/omp\n');
      },
    );
    await expect(resolveOmpBin('omp', exec as never)).rejects.toThrow(
      /encontrado 17\.0\.5.*suportado 17\.0\.4.*Ação:/s,
    );
  });

  it('recusa saída de versão ilegível em vez de pular o pin', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        cb(null, args[0] === '--version' ? 'omp development build\n' : '/x/omp\n');
      },
    );
    await expect(resolveOmpBin('omp', exec as never)).rejects.toThrow(
      /não informou uma versão semântica.*Ação:/s,
    );
  });

  it('recusa prerelease com o mesmo core semver', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        cb(
          null,
          args[0] === '--version' ? 'omp/17.0.4-rc.1\n' : '/x/omp\n',
        );
      },
    );
    await expect(resolveOmpBin('omp', exec as never)).rejects.toThrow(
      /encontrado 17\.0\.4-rc\.1.*suportado 17\.0\.4/s,
    );
  });

  // Bug NEXUS-UI-BUGS-001 §2: brew install pós-boot não aparece no PATH
  // herdado — o retry com o PATH do login shell ao vivo precisa achar o omp.
  it.skipIf(process.platform === 'win32')(
    'which rápido falha → retenta com o PATH do login shell e usa esse PATH no --version',
    async () => {
      // Diretório marcador que SÓ a sonda de login shell devolve: o which
      // rápido falha de forma determinística, independente do PATH real do
      // runner de teste.
      const loginPath = ['/fake-login/bin', '/opt/homebrew/bin'].join(path.delimiter);
      const calls: Array<{ file: string; args: string[]; envPath?: string }> = [];
      const exec = vi.fn(
        (
          file: string,
          args: string[],
          opts: { timeout: number; env?: NodeJS.ProcessEnv },
          cb: (err: Error | null, stdout: string) => void,
        ) => {
          calls.push({ file, args, envPath: opts.env?.PATH });
          if (args[0] === '--version') {
            cb(null, 'omp/17.0.4\n');
          } else if (args[0] === '-l') {
            cb(null, loginPath);
          } else if (file === 'which') {
            if (opts.env?.PATH?.includes('/fake-login/bin')) {
              cb(null, '/opt/homebrew/bin/omp\n');
            } else {
              cb(new Error('which: no omp in path'), '');
            }
          } else {
            cb(new Error(`chamada inesperada: ${file} ${args.join(' ')}`), '');
          }
        },
      );
      const resolved = await resolveOmpBin('omp', exec as never);
      expect(resolved.binPath).toBe('/opt/homebrew/bin/omp');
      expect(resolved.version).toBe('17.0.4');
      // Duas sondagens: a rápida (PATH do processo) + o retry (login shell).
      expect(calls.filter((c) => c.file === 'which')).toHaveLength(2);
      // O --version roda com o PATH efetivo — o que de fato achou o binário.
      const versionCall = calls.find((c) => c.args[0] === '--version');
      expect(versionCall?.envPath).toContain('/fake-login/bin');
    },
  );

  it('which falha nas duas passadas → erro orientando brew install', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number; env?: NodeJS.ProcessEnv },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === '-l') {
          cb(null, ['/somente-login', '/usr/bin'].join(path.delimiter));
        } else {
          cb(new Error('not found'), '');
        }
      },
    );
    await expect(resolveOmpBin('omp', exec as never)).rejects.toThrow(
      /brew install can1357\/tap\/omp/,
    );
    // Sem binário localizado, nenhuma sonda de versão acontece.
    const versionCalls = exec.mock.calls.filter(
      (call) => (call[1] as string[])[0] === '--version',
    );
    expect(versionCalls).toHaveLength(0);
  });

  it('sucesso fica em cache — o segundo resolve não re-sonda', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        cb(null, args[0] === '--version' ? 'omp/17.0.4\n' : '/opt/homebrew/bin/omp\n');
      },
    );
    const first = await resolveOmpBin('omp', exec as never);
    const second = await resolveOmpBin('omp', exec as never);
    expect(second).toEqual(first);
    // which + --version uma única vez; o segundo resolve veio do cache.
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('handshake e ciclo de vida', () => {
  it('encerra fail-closed quando um frame NDJSON sem newline excede 1 MiB', async () => {
    const harness = createHarness();
    harness.proc.emitStdout('x'.repeat(OMP_RPC_MAX_FRAME_CHARS + 1));

    expect(harness.proc.kills).toContain('SIGTERM');
    expect(harness.pushes).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        level: 'error',
        message: expect.stringMatching(/frame NDJSON.*1 MiB/i),
      }),
    );
    await expect(harness.session.prompt('must be rejected')).rejects.toThrow(
      /sessão omp encerrada/i,
    );
  });

  it('spawning → ready → idle após set_host_tools + get_state', async () => {
    const harness = createHarness();
    expect(harness.session.state).toBe('spawning');
    await becomeIdle(harness);
    const snapshot = harness.session.snapshot();
    expect(snapshot.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
    expect(snapshot.contextUsage?.percent).toBe(0.55);
    expect(snapshot.sessionName).toBe('B1');
  });

  it('comandos antes do ready ficam na fila e vão após o handshake', async () => {
    const harness = createHarness();
    const promptPromise = harness.session.prompt('Summarize this repo');
    expect(harness.proc.written).toHaveLength(0); // ainda sem ready
    harness.proc.emitFrame({ type: 'ready' });
    await Promise.resolve();
    expect(harness.proc.lastWritten('prompt')).toBeUndefined();
    const hostTools = harness.proc.lastWritten('set_host_tools');
    harness.proc.emitFrame({
      id: hostTools?.id,
      type: 'response',
      command: 'set_host_tools',
      success: true,
    });
    await vi.waitFor(() => {
      expect(harness.proc.lastWritten('get_state')).toBeDefined();
    });
    const getState = harness.proc.lastWritten('get_state');
    harness.proc.emitFrame({
      id: getState?.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { isStreaming: false },
    });
    await vi.waitFor(() => {
      expect(harness.proc.lastWritten('prompt')).toBeDefined();
    });
    const prompt = harness.proc.lastWritten('prompt');
    harness.proc.emitFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
    });
    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('remove comandos pré-ready expirados e nunca os executa tardiamente', async () => {
    const harness = createHarness({ requestTimeoutMs: 100 });
    for (let index = 0; index < 3; index += 1) {
      await expect(
        harness.session.prompt(`expired-before-ready-${index}`),
      ).rejects.toThrow(/timeout aguardando resposta de prompt/i);
    }
    expect(harness.proc.lastWritten('prompt')).toBeUndefined();

    await becomeIdle(harness);
    expect(
      harness.proc.written
        .map((line) => JSON.parse(line) as { type?: string })
        .filter((frame) => frame.type === 'prompt'),
    ).toHaveLength(0);
  });

  it('prompt→ack→agent_start→deltas→agent_end deriva busy→idle', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    const { proc, session, pushes } = harness;

    const promptPromise = session.prompt('Summarize this repo');
    const prompt = proc.lastWritten('prompt');
    expect(prompt?.streamingBehavior).toBeUndefined(); // idle: sem behavior
    proc.emitFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
    });
    await promptPromise;

    proc.emitFrame({ type: 'agent_start' });
    expect(session.state).toBe('busy');

    // Frame de docs/rpc.md §Compact Command Flows.
    proc.emitFrame({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Olá ' },
      message: { role: 'assistant', content: [] },
    });
    proc.emitFrame({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'mundo' },
      message: { role: 'assistant', content: [] },
    });
    proc.emitFrame({ type: 'agent_end', messages: [] });
    expect(session.state).toBe('idle');

    const deltas = pushes
      .filter((event) => event.kind === 'text-delta')
      .map((event) => (event.kind === 'text-delta' ? event.delta : ''));
    expect(deltas).toEqual(['Olá ', 'mundo']);
    const statusStates = pushes
      .filter((event) => event.kind === 'status')
      .map((event) => (event.kind === 'status' ? event.state : ''));
    expect(statusStates).toContain('busy');
    expect(statusStates[statusStates.length - 1]).toBe('idle');

    // agent_end dispara refresh de get_state.
    await vi.waitFor(() => {
      const refresh = proc.lastWritten('get_state');
      expect(refresh).toBeDefined();
    });
  });

  it('redacts exact launch credentials and generic secrets before logs, pushes, previews, audit and host dispatch', async () => {
    const syntheticCredential = 'nexus-synthetic-credential-92XY';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const harness = createHarness({
        sessionConfig: {
          env: {
            PATH: '/usr/bin',
            XAI_API_KEY: syntheticCredential,
          },
          credentialSecrets: [syntheticCredential],
        },
      });
      await becomeIdle(harness);

      const splitAt = Math.floor(syntheticCredential.length / 2);
      harness.proc.emitFrame({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: `before ${syntheticCredential.slice(0, splitAt)}`,
        },
      });
      harness.proc.emitFrame({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: `${syntheticCredential.slice(splitAt)} after`,
        },
      });
      harness.proc.emitFrame({ type: 'message_end' });
      harness.proc.emitFrame({
        type: 'tool_execution_start',
        toolCallId: 'tool-redaction',
        toolName: 'nexus_mission_get',
        args: {
          missionId: syntheticCredential,
          authorization: 'Bearer synthetic-bearer-value',
        },
      });
      harness.proc.emitFrame({
        type: 'host_tool_call',
        id: 'host-redaction',
        toolCallId: 'host-redaction',
        toolName: 'nexus_mission_get',
        arguments: { missionId: syntheticCredential },
      });
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1));
      harness.proc.emitFrame({
        type: 'extension_ui_request',
        id: 'ui-redaction',
        method: 'confirm',
        title: `Allow ${syntheticCredential}`,
      });
      harness.proc.emitStderr(
        `provider error: ${syntheticCredential.slice(0, splitAt)}`,
      );
      harness.proc.emitStderr(
        `${syntheticCredential.slice(splitAt)}\n`,
      );
      harness.proc.emitStdout(`invalid diagnostic ${syntheticCredential}\n`);
      harness.proc.exit(1);

      const outward = JSON.stringify({
        pushes: harness.pushes,
        dispatched: harness.dispatched,
        audits: harness.audits,
        snapshot: harness.session.snapshot(),
        warnings: warn.mock.calls,
      });
      expect(outward).not.toContain(syntheticCredential);
      expect(outward).not.toContain('synthetic-bearer-value');
      expect(outward).toContain('[REDACTED]');
      expect(harness.dispatched[0]?.args).toEqual({
        missionId: '[REDACTED]',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('discards per-session redaction tails on dispose instead of retaining them for replay', async () => {
    const syntheticCredential = 'nexus-dispose-credential-41ZZ';
    const splitAt = Math.floor(syntheticCredential.length / 2);
    const harness = createHarness({
      sessionConfig: {
        env: {
          PATH: '/usr/bin',
          XAI_API_KEY: syntheticCredential,
        },
      },
    });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: syntheticCredential.slice(0, splitAt),
      },
    });

    await harness.session.terminate();
    // A late physical chunk after logical revocation is ignored, and the
    // retained prefix was cleared rather than flushed into the renderer.
    harness.proc.emitFrame({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: syntheticCredential.slice(splitAt),
      },
    });
    const replayable = JSON.stringify(harness.pushes);
    expect(replayable).not.toContain(syntheticCredential);
    expect(replayable).not.toContain(
      syntheticCredential.slice(0, splitAt),
    );
    expect(replayable).not.toContain(
      syntheticCredential.slice(splitAt),
    );
  });

  it('prompt durante streaming inclui streamingBehavior (nunca falha por omissão)', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    harness.proc.emitFrame({ type: 'agent_start' });
    const promptPromise = harness.session.prompt('Also include risks');
    const prompt = harness.proc.lastWritten('prompt');
    expect(prompt?.streamingBehavior).toBe('followUp');
    harness.proc.emitFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
    });
    await promptPromise;
  });

  it('não libera readiness no frame ready antes de host tools/model/state terminarem', async () => {
    const harness = createHarness();
    let settled = false;
    const ready = waitForOmpSessionReady(harness.session, 500, 1).then(() => {
      settled = true;
    });

    harness.proc.emitFrame({ type: 'ready' });
    await Promise.resolve();
    expect(harness.session.state).toBe('ready');
    expect(settled).toBe(false);

    const hostTools = harness.proc.lastWritten('set_host_tools');
    harness.proc.emitFrame({
      id: hostTools?.id,
      type: 'response',
      command: 'set_host_tools',
      success: true,
    });
    await vi.waitFor(() => expect(harness.proc.lastWritten('get_state')).toBeDefined());
    const getState = harness.proc.lastWritten('get_state');
    harness.proc.emitFrame({
      id: getState?.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        isStreaming: false,
        isCompacting: false,
        sessionId: 'omp-ready-proof',
      },
    });

    await ready;
    expect(harness.session.state).toBe('idle');
  });

  it('promptAndWaitForAgentStart não aceita ACK sozinho e resolve após agent_start', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    let settled = false;
    const accepted = harness.session
      .promptAndWaitForAgentStart('Execute a task', 500)
      .then(() => { settled = true; });
    const prompt = harness.proc.lastWritten('prompt');
    harness.proc.emitFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: true },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.proc.emitFrame({ type: 'agent_start' });
    await accepted;
    expect(settled).toBe(true);
  });

  it('promptAndWaitForAgentStart correlaciona agent_start anterior ao ACK', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    const accepted = harness.session.promptAndWaitForAgentStart('Execute', 500);
    const prompt = harness.proc.lastWritten('prompt');
    harness.proc.emitFrame({ type: 'agent_start' });
    harness.proc.emitFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: true },
    });
    await expect(accepted).resolves.toBeUndefined();
  });

  it('não aceita agent_start quando o processo morre no mesmo tick do chunk de ACK', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    const accepted = harness.session.promptAndWaitForAgentStart('Execute', 500);
    const prompt = harness.proc.lastWritten('prompt');

    // O child pode descarregar ACK + agent_start em um único chunk e morrer
    // antes da continuação assíncrona do host. O exit precisa vencer essa
    // corrida; aceitar aqui criaria um worker fantasma no store durável.
    harness.proc.emitStdout(
      `${JSON.stringify({
        id: prompt?.id,
        type: 'response',
        command: 'prompt',
        success: true,
        data: { agentInvoked: true },
      })}\n${JSON.stringify({ type: 'agent_start' })}\n`,
    );
    harness.proc.exit(137);

    await expect(accepted).rejects.toThrow(/encerrou antes de agent_start/i);
    expect(harness.session.state).toBe('exited');
    expect(harness.pushes.at(-1)).toEqual({ kind: 'exit', code: 137 });
  });

  it('promptAndWaitForAgentStart rejeita local-only por response ou prompt_result', async () => {
    const responseHarness = createHarness();
    await becomeIdle(responseHarness);
    const responseRejected = responseHarness.session.promptAndWaitForAgentStart(
      'Local only',
      500,
    );
    const responsePrompt = responseHarness.proc.lastWritten('prompt');
    responseHarness.proc.emitFrame({
      id: responsePrompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: false },
    });
    await expect(responseRejected).rejects.toThrow(/n[aã]o iniciou|local-only/i);

    const resultHarness = createHarness();
    await becomeIdle(resultHarness);
    const resultRejected = resultHarness.session.promptAndWaitForAgentStart(
      'No agent',
      500,
    );
    const resultPrompt = resultHarness.proc.lastWritten('prompt');
    resultHarness.proc.emitFrame({
      id: resultPrompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: true },
    });
    resultHarness.proc.emitFrame({
      type: 'prompt_result',
      id: resultPrompt?.id,
      agentInvoked: false,
    });
    await expect(resultRejected).rejects.toThrow(/n[aã]o iniciou|local-only/i);
  });
});

describe('correlação de respostas por id', () => {
  it('resolve respostas fora de ordem pelo id, nunca pela ordem de emissão', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    const { proc, session } = harness;

    const modelsPromise = session.listModels();
    const statePromise = session.prompt('x');
    const models = proc.lastWritten('get_available_models');
    const prompt = proc.lastWritten('prompt');
    expect(models?.id).not.toBe(prompt?.id);

    // Responde na ordem INVERSA da emissão.
    proc.emitFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
    });
    proc.emitFrame({
      id: models?.id,
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Sonnet' },
          { provider: 'openai-codex', id: 'gpt-5.5' },
        ],
      },
    });

    await expect(statePromise).resolves.toBeUndefined();
    await expect(modelsPromise).resolves.toEqual([
      { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Sonnet' },
      { provider: 'openai-codex', id: 'gpt-5.5' },
    ]);
  });

  it('resposta de erro rejeita a promise correspondente', async () => {
    const harness = createHarness();
    await becomeIdle(harness);
    const promise = harness.session.setModel('nope', 'missing');
    const setModel = harness.proc.lastWritten('set_model');
    harness.proc.emitFrame({
      id: setModel?.id,
      type: 'response',
      command: 'set_model',
      success: false,
      error: 'Model not found: nope/missing',
    });
    await expect(promise).rejects.toThrow('Model not found: nope/missing');
  });
});

describe('extension_ui_request — open_url', () => {
  it('open_url vira push open-url com a URL (fluxo de /login OAuth)', async () => {
    const harness = createHarness({ approvalPolicy: 'yolo' });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_url_1',
      method: 'open_url',
      url: 'https://auth.example.com/oauth?code=abc',
    });
    const openUrl = harness.pushes.find((event) => event.kind === 'open-url');
    expect(openUrl).toMatchObject({
      url: 'https://auth.example.com/oauth?code=abc',
    });
    // open_url não é aprovação: nada de auto-resposta nem auditoria.
    expect(harness.audits).toHaveLength(0);
  });

  it('open_url sem URL vira aviso, nunca um link vazio', async () => {
    const harness = createHarness({ approvalPolicy: 'yolo' });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_url_2',
      method: 'open_url',
    });
    expect(
      harness.pushes.find((event) => event.kind === 'open-url'),
    ).toBeUndefined();
    const notice = harness.pushes.find(
      (event) => event.kind === 'notice' && event.level === 'warning',
    );
    expect(notice).toBeDefined();
  });
});

describe('extension_ui_request — política yolo', () => {
  it('confirm é auto-aprovado e auditado ANTES da resposta', async () => {
    const harness = createHarness({ approvalPolicy: 'yolo' });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_1',
      method: 'confirm',
      title: 'Allow tool: bash',
      message: 'Continue?',
      timeout: 30000,
    });
    const response = harness.proc.lastWritten('extension_ui_response');
    expect(response).toMatchObject({ id: 'ui_1', confirmed: true });
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toMatchObject({
      method: 'confirm',
      decision: 'confirmed',
      title: 'Allow tool: bash',
    });
    const badge = harness.pushes.find((event) => event.kind === 'auto-approval');
    expect(badge).toMatchObject({ decision: 'confirmed', total: 1 });
  });

  it('select de aprovação escolhe a opção afirmativa', async () => {
    const harness = createHarness({ approvalPolicy: 'yolo' });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_2',
      method: 'select',
      title: 'Tool approval required',
      options: ['Deny', 'Approve once', 'Approve always'],
    });
    const response = harness.proc.lastWritten('extension_ui_response');
    expect(response).toMatchObject({ id: 'ui_2', value: 'Approve once' });
    expect(harness.audits[0]?.decision).toBe('selected');
  });

  it('input/editor cancelam (sem resposta genérica) e ainda auditam', async () => {
    const harness = createHarness({ approvalPolicy: 'yolo' });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_7',
      method: 'input',
      title: 'Branch name',
      placeholder: 'feature/...',
    });
    const response = harness.proc.lastWritten('extension_ui_response');
    expect(response).toMatchObject({ id: 'ui_7', cancelled: true });
    expect(harness.audits[0]?.decision).toBe('cancelled');
  });

  it('auditoria indisponível degrada aprovação para DENY', async () => {
    const harness = createHarness({
      approvalPolicy: 'yolo',
      auditAutoApproval: () => {
        throw new Error('audit_unavailable');
      },
    });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_3',
      method: 'confirm',
      title: 'Allow tool: bash',
      message: 'Continue?',
    });
    const response = harness.proc.lastWritten('extension_ui_response');
    expect(response).toMatchObject({ id: 'ui_3', cancelled: true });
    expect(response?.confirmed).toBeUndefined();
  });
});

describe('extension_ui_request — política safe', () => {
  it('nega pedidos acima do limite sem ampliar o mapa pendente', async () => {
    const harness = createHarness({ approvalPolicy: 'safe' });
    await becomeIdle(harness);
    for (let index = 0; index < OMP_RPC_MAX_PENDING_UI; index += 1) {
      harness.proc.emitFrame({
        type: 'extension_ui_request',
        id: `ui-bounded-${index}`,
        method: 'confirm',
        title: 'Allow tool',
      });
    }
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui-overflow',
      method: 'confirm',
      title: 'Allow tool overflow',
    });

    expect(
      harness.pushes.filter((event) => event.kind === 'ui-request'),
    ).toHaveLength(OMP_RPC_MAX_PENDING_UI);
    expect(harness.proc.lastWritten('extension_ui_response')).toMatchObject({
      id: 'ui-overflow',
      cancelled: true,
    });
    harness.session.dispose();
  });

  it('encaminha ao renderer e devolve a resposta do usuário', async () => {
    const harness = createHarness({ approvalPolicy: 'safe' });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_9',
      method: 'confirm',
      title: 'Allow tool: bash',
      message: 'Continue?',
    });
    const forwarded = harness.pushes.find((event) => event.kind === 'ui-request');
    expect(forwarded).toMatchObject({
      requestId: 'ui_9',
      method: 'confirm',
      title: 'Allow tool: bash',
    });
    // Nada foi respondido automaticamente.
    expect(harness.proc.lastWritten('extension_ui_response')).toBeUndefined();

    const accepted = harness.session.respondUi('ui_9', { confirmed: true });
    expect(accepted).toBe(true);
    expect(harness.proc.lastWritten('extension_ui_response')).toMatchObject({
      id: 'ui_9',
      confirmed: true,
    });
    expect(harness.audits).toHaveLength(0); // safe não passa pelo auto-responder
  });

  it('timeout sem resposta vira default deny (cancelled + timedOut)', async () => {
    const harness = createHarness({
      approvalPolicy: 'safe',
      uiResponseTimeoutMs: 20,
    });
    await becomeIdle(harness);
    harness.proc.emitFrame({
      type: 'extension_ui_request',
      id: 'ui_10',
      method: 'confirm',
      title: 'Allow tool: bash',
    });
    await vi.waitFor(() => {
      expect(harness.proc.lastWritten('extension_ui_response')).toMatchObject({
        id: 'ui_10',
        cancelled: true,
        timedOut: true,
      });
    });
    // Depois do timeout a resposta do usuário não é mais aceita.
    expect(harness.session.respondUi('ui_10', { confirmed: true })).toBe(false);
  });
});

describe('fence físico da árvore OMP', () => {
  it('prova child-never-spawned quando error ocorre sem PID', async () => {
    const terminateProcessTree = vi.fn<
      NonNullable<OmpRpcSessionDeps['terminateProcessTree']>
    >();
    const captureProcessTree = vi.fn<
      NonNullable<OmpRpcSessionDeps['captureProcessTree']>
    >();
    const harness = createHarness({
      processPid: null,
      terminateProcessTree,
      captureProcessTree,
    });

    harness.proc.fail(
      Object.assign(new Error('spawn /missing/omp ENOENT'), {
        code: 'ENOENT',
      }),
    );

    await expect(harness.session.terminate()).resolves.toEqual({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.proc.kills).toEqual([]);
    expect(harness.session.state).toBe('exited');
    expect(harness.pushes).toContainEqual({ kind: 'exit', code: null });
  });

  it('só conclui terminate após o callback exato do root e a prova dos descendentes', async () => {
    const terminateProcessTree = vi.fn(
      async (
        input: Parameters<
          NonNullable<OmpRpcSessionDeps['terminateProcessTree']>
        >[0],
      ) => {
        input.killRoot('SIGTERM');
        await input.rootExited;
        return {
          ok: true,
          rootExited: true,
          descendantsExited: true,
        };
      },
    );
    const harness = createHarness({ terminateProcessTree });
    let settled = false;
    const termination = harness.session.terminate().then((proof) => {
      settled = true;
      return proof;
    });

    await Promise.resolve();
    expect(harness.proc.kills).toEqual(['SIGTERM']);
    expect(settled).toBe(false);

    harness.proc.exit(0);
    await expect(termination).resolves.toEqual({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    expect(terminateProcessTree).toHaveBeenCalledOnce();
  });

  it('retries a same-second first inventory and proves a later natural clean exit', async () => {
    const root = {
      pid: 4242,
      ppid: 1,
      pgid: 4242,
      sid: 4242,
      tty: '??',
      startedAt: 'Sat Jul 25 12:00:00 2026',
    };
    const startedAtMs = Date.parse(root.startedAt);
    const captureProcessTree = vi
      .fn()
      .mockResolvedValueOnce({
        root,
        descendants: [],
        inventory: [root],
        capturedAtMs: startedAtMs + 500,
      })
      .mockResolvedValueOnce({
        root,
        descendants: [],
        inventory: [root],
        capturedAtMs: startedAtMs + 2_500,
      })
      .mockResolvedValue({
        root: null,
        descendants: [],
        inventory: [],
        capturedAtMs: startedAtMs + 4_000,
      });
    const harness = createHarness({
      captureProcessTree,
      processInventoryIntervalMs: 100,
    });

    await vi.waitFor(() => {
      expect(captureProcessTree).toHaveBeenCalledTimes(2);
    });
    harness.proc.exit(0);

    await expect(harness.session.terminate()).resolves.toEqual({
      ok: true,
      rootExited: true,
      descendantsExited: true,
    });
    expect(captureProcessTree).toHaveBeenCalledTimes(4);
  });

  it('fails closed after natural crash while a captured descendant remains alive', async () => {
    const root = {
      pid: 4242,
      ppid: 1,
      pgid: 4242,
      sid: 4242,
      tty: '??',
      startedAt: 'Sat Jul 25 11:00:00 2026',
    };
    const child = {
      pid: 4243,
      ppid: 4242,
      pgid: 4242,
      sid: 4242,
      tty: '??',
      startedAt: 'Sat Jul 25 11:00:01 2026',
    };
    const captureProcessTree = vi
      .fn()
      .mockResolvedValueOnce({
        root,
        descendants: [child],
        inventory: [root, child],
        capturedAtMs: Date.parse('Sat Jul 25 11:00:10 2026'),
      })
      .mockResolvedValue({
        root: null,
        descendants: [],
        inventory: [child],
        capturedAtMs: Date.parse('Sat Jul 25 11:00:20 2026'),
      });
    const harness = createHarness({ captureProcessTree });
    await vi.waitFor(() => {
      expect(captureProcessTree).toHaveBeenCalledOnce();
    });
    harness.proc.exit(137);

    await expect(harness.session.terminate()).resolves.toMatchObject({
      ok: false,
      rootExited: true,
      descendantsExited: false,
      error: expect.stringMatching(/pós-exit.*descendentes/i),
    });
  });
});

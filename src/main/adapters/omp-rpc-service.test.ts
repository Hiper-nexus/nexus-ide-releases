import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ompExtensionUiRequestSchema,
  ompHostToolCallFrameSchema,
  ompResponseFrameSchema,
  ompSessionStateSchema,
  type OmpRpcPushEvent,
} from '../../shared/omp-rpc-types';
import {
  OmpRpcSession,
  buildOmpChildEnv,
  ompControlArgs,
  resolveOmpBin,
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
  it('valida a versão pinada via omp --version', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === '--version') cb(null, 'omp 17.0.0\n');
        else cb(null, '/opt/homebrew/bin/omp\n');
      },
    );
    const resolved = await resolveOmpBin('omp', exec as never);
    expect(resolved.binPath).toBe('/opt/homebrew/bin/omp');
    expect(resolved.version).toBe('17.0.0');
  });

  it('recusa major incompatível', async () => {
    const exec = vi.fn(
      (
        _file: string,
        args: string[],
        _opts: { timeout: number },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        cb(null, args[0] === '--version' ? 'omp 18.2.0\n' : '/x/omp\n');
      },
    );
    await expect(resolveOmpBin('omp', exec as never)).rejects.toThrow(
      /incompatível/,
    );
  });
});

describe('handshake e ciclo de vida', () => {
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
    const prompt = harness.proc.lastWritten('prompt');
    expect(prompt).toBeDefined();
    harness.proc.emitFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
    });
    await expect(promptPromise).resolves.toBeUndefined();
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

import { describe, expect, it, vi } from 'vitest';
import {
  formatTriageContext,
  handleHookTriageRequest,
  parseBashFailure,
} from './hook-triage-endpoint';
import type { CommandTriage } from '../jev/jev-terminal-triage';
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { __resetMaestroInboxNoticeForTests } from './maestro-inbox-notice';
import { __resetAgentNudgeForTests, type AgentNudgeEvent } from './maestro-agent-nudge';
import { INBOX_POLL_BODY } from './hook-triage-command';

const ctx = { sessionId: 's1' };

describe('parseBashFailure', () => {
  it('parses the documented PostToolUseFailure payload', () => {
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: "Exit code 1\nError: Cannot find module 'express'",
      }),
    ).toEqual({
      command: 'npm test',
      exitCode: 1,
      output: "Error: Cannot find module 'express'",
    });
  });

  it('returns null for non-Bash tools', () => {
    expect(
      parseBashFailure({
        tool_name: 'Edit',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(parseBashFailure(null)).toBeNull();
    expect(parseBashFailure({ tool_name: 'Bash' })).toBeNull();
  });

  it('returns null when tool_input or a non-empty command is missing', () => {
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: 'não-objeto',
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: '   ' },
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: 42 },
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
  });

  it('defaults exitCode to 1 and keeps the full text without an exit-code line', () => {
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: 'make' },
        error: 'spawn make ENOENT\nmore detail',
      }),
    ).toEqual({
      command: 'make',
      exitCode: 1,
      output: 'spawn make ENOENT\nmore detail',
    });
  });
});

describe('formatTriageContext', () => {
  it('formats the kind label, confidence and retry hint in pt-BR', () => {
    const text = formatTriageContext({
      kind: 'environment',
      confidence: 0.82,
      retryHelps: 0.1,
      model: 'jev',
    });
    expect(text).toContain('[Nexus · Jev]');
    expect(text).toContain('ambiente da máquina');
    expect(text).toContain('0.82');
    expect(text).toContain('provavelmente falha igual');
    expect(text.length).toBeLessThanOrEqual(400);
  });
});

describe('handleHookTriageRequest', () => {
  it('returns hookSpecificOutput.additionalContext when triage has a verdict', async () => {
    const triage = vi.fn(
      async (): Promise<CommandTriage> => ({
        kind: 'environment',
        confidence: 0.82,
        retryHelps: 0.1,
        model: 'jev',
      }),
    );
    const result = await handleHookTriageRequest(
      ctx,
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nnode: command not found',
      },
      { triage },
    );
    expect(result.statusCode).toBe(200);
    const output = (result.payload as Record<string, unknown>)
      .hookSpecificOutput as Record<string, unknown>;
    expect(output.hookEventName).toBe('PostToolUseFailure');
    expect(String(output.additionalContext)).toContain('ambiente da máquina');
    expect(triage).toHaveBeenCalledWith(
      {
        command: 'npm test',
        exitCode: 1,
        output: 'node: command not found',
      },
      expect.anything(),
    );
  });

  it('returns {} for unparseable payloads without calling triage', async () => {
    const triage = vi.fn();
    const result = await handleHookTriageRequest(
      ctx,
      { tool_name: 'Edit', error: 'Exit code 1\nx' },
      { triage },
    );
    expect(result).toEqual({ statusCode: 200, payload: {} });
    expect(triage).not.toHaveBeenCalled();
  });

  it('returns {} when triage is unavailable (surface off / no credential)', async () => {
    const result = await handleHookTriageRequest(
      ctx,
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nboom',
      },
      { triage: vi.fn(async () => null) },
    );
    expect(result).toEqual({ statusCode: 200, payload: {} });
  });

  it('returns {} when triage throws — the hook never disturbs Claude', async () => {
    const result = await handleHookTriageRequest(
      ctx,
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nboom',
      },
      {
        triage: vi.fn(async () => {
          throw new Error('jev exploded');
        }),
      },
    );
    expect(result).toEqual({ statusCode: 200, payload: {} });
  });
});

// F-1359: Maestro ocupado não via as entregas presas atrás da borda idle.
describe('handleHookTriageRequest — fila do Maestro ocupado (PostToolUse)', () => {
  const scope = { projectId: 'p', rootRealPath: '/repo' } as unknown as ProjectExecutionScope;
  const maestro = {
    role: 'orchestrator' as const,
    missionId: 'mission-1',
    sessionId: 'pty-maestro',
    scope,
  };
  const poll = JSON.parse(INBOX_POLL_BODY) as unknown;
  const handoff = (id: string, fromAgent: string, extra: Partial<Handoff> = {}): Handoff =>
    ({ id, missionId: 'mission-1', sessionId: `pty-${id}`, fromAgent, status: 'success', ...extra }) as Handoff;

  function contextOf(result: { payload: Record<string, unknown> }): string | undefined {
    return (result.payload.hookSpecificOutput as { additionalContext?: string } | undefined)
      ?.additionalContext;
  }

  it('avisa a fila uma vez, não repete sem entrega nova e volta a avisar quando ela muda', async () => {
    __resetMaestroInboxNoticeForTests();
    let pending: Handoff[] = [
      handoff('handoff-ba609d8d-00be', 'Grok'),
      handoff('handoff-c2c020c5-5b6e', 'Kimi', { status: 'partial' }),
      // Diagnóstico que nunca cola e o próprio submit do Maestro não contam.
      handoff('handoff-diag', 'nexus-mission-driver', { status: 'stalled' }),
      handoff('handoff-self', 'Claude', { sessionId: 'pty-maestro' }),
    ];
    const listUndelivered = vi.fn((s: unknown, missionId: string) => {
      expect(s).toBe(scope);
      expect(missionId).toBe('mission-1');
      return pending;
    });

    const first = await handleHookTriageRequest(maestro, poll, { listUndelivered });
    expect(first.payload.hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUse' });
    expect(contextOf(first)).toBe(
      '[Nexus] 2 entregas na fila: Grok handoff-ba609d8d success; Kimi handoff-c2c020c5 partial. ' +
        'Elas colam quando seu turno acabar; para ler agora, nexus_handoff_list.',
    );

    // Mesma fila na próxima ferramenta: nada.
    expect(await handleHookTriageRequest(maestro, poll, { listUndelivered })).toEqual({
      statusCode: 200,
      payload: {},
    });

    // Entrou entrega nova: a linha volta com a fila inteira.
    pending = [...pending, handoff('handoff-a38c03fd-2961', 'Devin CLI', { status: 'blocked' })];
    expect(contextOf(await handleHookTriageRequest(maestro, poll, { listUndelivered }))).toContain(
      '3 entregas na fila: Grok handoff-ba609d8d success; Kimi handoff-c2c020c5 partial; ' +
        'Devin CLI handoff-a38c03fd blocked.',
    );

    // Fila esvaziou (colou no idle) e voltou a encher com a mesma id: avisa de novo.
    pending = [];
    expect(await handleHookTriageRequest(maestro, poll, { listUndelivered })).toEqual({
      statusCode: 200,
      payload: {},
    });
    pending = [handoff('handoff-ba609d8d-00be', 'Grok')];
    expect(contextOf(await handleHookTriageRequest(maestro, poll, { listUndelivered }))).toContain(
      '[Nexus] 1 entrega na fila: Grok handoff-ba609d8d success.',
    );
  });

  it('pane que não é Maestro de missão não recebe aviso nem consulta a fila', async () => {
    __resetMaestroInboxNoticeForTests();
    const listUndelivered = vi.fn(() => [handoff('handoff-x', 'Grok')]);
    for (const ctx of [
      { sessionId: 's1' },
      { ...maestro, role: 'worker' as const },
      { ...maestro, missionId: undefined },
    ]) {
      expect(await handleHookTriageRequest(ctx, poll, { listUndelivered })).toEqual({
        statusCode: 200,
        payload: {},
      });
    }
    expect(listUndelivered).not.toHaveBeenCalled();
  });

  it('o poll da fila nunca chama a triagem do Jev', async () => {
    __resetMaestroInboxNoticeForTests();
    const triage = vi.fn();
    await handleHookTriageRequest(maestro, poll, { triage, listUndelivered: () => [] });
    expect(triage).not.toHaveBeenCalled();
  });
});

// F-1396: o Maestro escolheu o atalho de subagentes internos (tool Agent/Task)
// em vez de abrir panes — trabalho invisível ao Nexus. O hook PreToolUse
// responde additionalContext pelo mesmo canal aditivo, sem bloquear a tool.
describe('handleHookTriageRequest — atalho de subagente (PreToolUse/Agent)', () => {
  const scope = { projectId: 'p', rootRealPath: '/repo' } as unknown as ProjectExecutionScope;
  const maestro = {
    role: 'orchestrator' as const,
    missionId: 'mission-1',
    sessionId: 'pty-maestro',
    scope,
  };
  const agentCall = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose' },
  };

  function contextOf(result: { payload: Record<string, unknown> }): string | undefined {
    return (result.payload.hookSpecificOutput as { additionalContext?: string } | undefined)
      ?.additionalContext;
  }

  it('(a) Maestro de missão chamando Agent → additionalContext com os workers vivos e o atalho do Nexus', async () => {
    __resetAgentNudgeForTests();
    const result = await handleHookTriageRequest(maestro, agentCall, { countLiveWorkers: () => 0 });
    expect(result.payload.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
    expect(contextOf(result)).toContain('0 workers vivos');
    expect(contextOf(result)).toContain('nexus_pane_spawn');
    expect(contextOf(result)).toContain('handoff');
  });

  it('a contagem é da MISSÃO do pane (o deps recebe o missionId do gate), não do payload', async () => {
    __resetAgentNudgeForTests();
    const seen: string[] = [];
    await handleHookTriageRequest(maestro, agentCall, {
      countLiveWorkers: (missionId) => {
        seen.push(missionId);
        return 2;
      },
    });
    expect(seen).toEqual(['mission-1']);
  });

  it('(b) model fable → {} (revisor obrigatório, o atalho é o uso certo ali)', async () => {
    __resetAgentNudgeForTests();
    const countLiveWorkers = vi.fn(() => 0);
    const result = await handleHookTriageRequest(
      maestro,
      { ...agentCall, tool_input: { subagent_type: 'general-purpose', model: 'claude-fable-5-1' } },
      { countLiveWorkers },
    );
    expect(result).toEqual({ statusCode: 200, payload: {} });
    expect(countLiveWorkers).not.toHaveBeenCalled();
  });

  it('(c) pane que não é o Maestro da missão → {} e a contagem não é consultada', async () => {
    __resetAgentNudgeForTests();
    const countLiveWorkers = vi.fn(() => 0);
    for (const ctx of [
      { sessionId: 's1' },
      { ...maestro, role: 'worker' as const },
      { ...maestro, missionId: undefined },
    ]) {
      expect(await handleHookTriageRequest(ctx, agentCall, { countLiveWorkers })).toEqual({
        statusCode: 200,
        payload: {},
      });
    }
    expect(countLiveWorkers).not.toHaveBeenCalled();
  });

  it('(d) Explore/Plan/claude-code-guide → {} (leitura curta não pede pane)', async () => {
    __resetAgentNudgeForTests();
    const countLiveWorkers = vi.fn(() => 0);
    for (const subagent of ['Explore', 'Plan', 'claude-code-guide']) {
      expect(
        await handleHookTriageRequest(
          maestro,
          { ...agentCall, tool_input: { subagent_type: subagent } },
          { countLiveWorkers },
        ),
      ).toEqual({ statusCode: 200, payload: {} });
    }
    expect(countLiveWorkers).not.toHaveBeenCalled();
  });

  it('conta por missão no trace, sem nunca carregar o prompt do subagente', async () => {
    __resetAgentNudgeForTests();
    const seen: AgentNudgeEvent[] = [];
    const deps = { countLiveWorkers: () => 1, onAgentNudge: (e: AgentNudgeEvent) => seen.push(e) };
    const call = { ...agentCall, tool_input: { subagent_type: 'general-purpose', prompt: 'hunter2' } };
    await handleHookTriageRequest(maestro, call, deps);
    await handleHookTriageRequest(maestro, call, deps);
    expect(seen.map((e) => [e.missionId, e.count, e.liveWorkers])).toEqual([
      ['mission-1', 1, 1],
      ['mission-1', 2, 1],
    ]);
    expect(JSON.stringify(seen)).not.toContain('hunter2');
  });

  it('a triagem de falha de Bash continua intacta no mesmo endpoint', async () => {
    __resetAgentNudgeForTests();
    const triage = vi.fn(async (): Promise<CommandTriage> => ({
      kind: 'environment',
      confidence: 0.82,
      retryHelps: 0.1,
      model: 'jev',
    }));
    const result = await handleHookTriageRequest(
      maestro,
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nboom' },
      { triage, countLiveWorkers: () => 0 },
    );
    expect(result.payload.hookSpecificOutput).toMatchObject({ hookEventName: 'PostToolUseFailure' });
    expect(triage).toHaveBeenCalledTimes(1);
  });

  it('o poll da fila (PostToolUse) não é confundido com a chamada de subagente', async () => {
    __resetAgentNudgeForTests();
    const poll = JSON.parse(INBOX_POLL_BODY) as unknown;
    const listUndelivered = vi.fn(() => []);
    const result = await handleHookTriageRequest(maestro, poll, {
      listUndelivered,
      countLiveWorkers: () => 0,
    });
    expect(result).toEqual({ statusCode: 200, payload: {} });
    expect(listUndelivered).toHaveBeenCalledTimes(1);
  });

  it('falha ao contar workers degrada para {} — o hook nunca atrapalha o turno', async () => {
    __resetAgentNudgeForTests();
    const result = await handleHookTriageRequest(maestro, agentCall, {
      countLiveWorkers: () => {
        throw new Error('inventário fora do ar');
      },
    });
    expect(result).toEqual({ statusCode: 200, payload: {} });
  });
});

import { describe, expect, it } from 'vitest';
import {
  __resetAgentNudgeForTests,
  formatAgentNudge,
  isWorkSubagent,
  maestroAgentNudge,
  parseAgentToolCall,
  type AgentNudgeEvent,
} from './maestro-agent-nudge';
import type { ProjectExecutionScope } from '../../shared/types';

/**
 * F-1396 — o Maestro delegou a versão inteira pela tool interna `Agent` do
 * Claude Code: subagentes in-process, todos Claude, invisíveis ao Nexus (sem
 * roteamento entre LLMs, sem quadro, sem handoff). O hook injeta uma linha de
 * `additionalContext` — nunca bloqueio — apontando `nexus_pane_spawn`.
 */

const scope = { projectId: 'p', rootRealPath: '/repo' } as unknown as ProjectExecutionScope;

const maestro = {
  role: 'orchestrator' as const,
  missionId: 'mission-1',
  sessionId: 'pty-maestro',
  scope,
};

/** Chama a tool Agent de trabalho — o caso que o F-1396 quer ver nudge. */
const agentCall = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { subagent_type: 'general-purpose' },
};

describe('parseAgentToolCall', () => {
  it('lê a chamada documentada da tool Agent (Claude Code)', () => {
    expect(
      parseAgentToolCall({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'general-purpose', description: 'corrigir o diff' },
      }),
    ).toEqual({ subagentType: 'general-purpose', model: null });
  });

  it('lê o modelo quando o Maestro fixa um (Task legado usa a mesma forma)', () => {
    expect(
      parseAgentToolCall({
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { subagent_type: 'general-purpose', model: 'fable' },
      }),
    ).toEqual({ subagentType: 'general-purpose', model: 'fable' });
  });

  it('sem subagent_type é trabalho (general-purpose implícito)', () => {
    expect(parseAgentToolCall({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} })).toEqual({
      subagentType: null,
      model: null,
    });
  });

  it('só a tool de subagente no PreToolUse: outra tool, outro evento ou corpo torto → null', () => {
    expect(parseAgentToolCall({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })).toBeNull();
    expect(parseAgentToolCall({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {} })).toBeNull();
    expect(parseAgentToolCall({ hook_event_name: 'PreToolUse', tool_name: 'Agent' })).toBeNull();
    expect(parseAgentToolCall(null)).toBeNull();
    expect(parseAgentToolCall('Agent')).toBeNull();
  });

  it('NUNCA carrega o prompt: só o rótulo do subagente e o modelo saem', () => {
    const call = parseAgentToolCall({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose', prompt: 'senha: hunter2', description: 'd' },
    });
    expect(JSON.stringify(call)).not.toContain('hunter2');
    expect(Object.keys(call!).sort()).toEqual(['model', 'subagentType']);
  });
});

describe('isWorkSubagent', () => {
  it('general-purpose, fork e sem tipo são trabalho', () => {
    expect(isWorkSubagent('general-purpose')).toBe(true);
    expect(isWorkSubagent('fork')).toBe(true);
    expect(isWorkSubagent(null)).toBe(true);
  });

  it('a leitura curta (Explore/Plan/claude-code-guide) não é trabalho de pane', () => {
    expect(isWorkSubagent('Explore')).toBe(false);
    expect(isWorkSubagent('explore')).toBe(false);
    expect(isWorkSubagent('Plan')).toBe(false);
    expect(isWorkSubagent('claude-code-guide')).toBe(false);
  });
});

describe('formatAgentNudge', () => {
  it('diz o número de workers vivos e aponta o nexus_pane_spawn', () => {
    const text = formatAgentNudge(0);
    expect(text).toContain('[Nexus]');
    expect(text).toContain('0 workers');
    expect(text).toContain('nexus_pane_spawn');
    expect(text).toContain('isolatedWriter');
    expect(text).toContain('handoff');
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it('o número é pluralizado e nunca some', () => {
    expect(formatAgentNudge(1)).toContain('1 worker vivo');
    expect(formatAgentNudge(7)).toContain('7 workers vivos');
  });
});

describe('maestroAgentNudge', () => {
  it('(a) orquestrador de missão chamando Agent de trabalho → additionalContext com a contagem', async () => {
    __resetAgentNudgeForTests();
    const text = await maestroAgentNudge(maestro, agentCall, { countLiveWorkers: () => 0 });
    expect(text).toContain('0 workers vivos');
    expect(text).toContain('nexus_pane_spawn');
  });

  it('(b) Agent com model fable → nada (é o revisor obrigatório, só existe via Agent)', async () => {
    __resetAgentNudgeForTests();
    let calls = 0;
    const countLiveWorkers = () => {
      calls += 1;
      return 0;
    };
    for (const model of ['fable', 'claude-fable-5-1', 'Fable']) {
      expect(await maestroAgentNudge(
          maestro,
          { ...agentCall, tool_input: { subagent_type: 'general-purpose', model } },
          { countLiveWorkers },
        ),
      ).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it('(c) pane que não é o Maestro da missão → nada, e a contagem não é consultada', async () => {
    __resetAgentNudgeForTests();
    let calls = 0;
    const countLiveWorkers = () => {
      calls += 1;
      return 0;
    };
    for (const ctx of [
      { sessionId: 's1' },
      { ...maestro, role: 'worker' as const },
      { ...maestro, role: 'user' as const },
      { ...maestro, missionId: undefined },
    ]) {
      expect(await maestroAgentNudge(ctx, agentCall, { countLiveWorkers })).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it('(d) Explore/Plan/claude-code-guide → nada (leitura curta não pede pane)', async () => {
    __resetAgentNudgeForTests();
    let calls = 0;
    const countLiveWorkers = () => {
      calls += 1;
      return 0;
    };
    for (const subagent of ['Explore', 'Plan', 'claude-code-guide']) {
      expect(await maestroAgentNudge(
          maestro,
          { ...agentCall, tool_input: { subagent_type: subagent } },
          { countLiveWorkers },
        ),
      ).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it('outra tool, outro evento ou corpo inválido → nada', async () => {
    __resetAgentNudgeForTests();
    const countLiveWorkers = () => 0;
    expect(await maestroAgentNudge(maestro, { hook_event_name: 'PreToolUse', tool_name: 'Read' }, { countLiveWorkers })).toBeNull();
    expect(await maestroAgentNudge(maestro, { hook_event_name: 'PostToolUse', tool_name: 'Agent' }, { countLiveWorkers })).toBeNull();
    expect(await maestroAgentNudge(maestro, null, { countLiveWorkers })).toBeNull();
  });

  it('conta por missão no trace e o contador é independente entre missões', async () => {
    __resetAgentNudgeForTests();
    const seen: AgentNudgeEvent[] = [];
    const deps = {
      countLiveWorkers: () => 3,
      onTrace: (event: AgentNudgeEvent) => seen.push(event),
    };
    await maestroAgentNudge(maestro, agentCall, deps);
    await maestroAgentNudge(maestro, agentCall, deps);
    await maestroAgentNudge({ ...maestro, missionId: 'mission-2' }, agentCall, deps);
    expect(seen.map((e) => [e.missionId, e.count, e.liveWorkers])).toEqual([
      ['mission-1', 1, 3],
      ['mission-1', 2, 3],
      ['mission-2', 1, 3],
    ]);
    // O trace carrega ids e contadores — nunca o conteúdo do prompt.
    for (const event of seen) {
      expect(JSON.stringify(event)).not.toMatch(/prompt|description/i);
    }
  });

  it('a contagem de workers vem do deps, da missão do pane (nunca do payload)', async () => {
    __resetAgentNudgeForTests();
    let calls = 0;
    const text = await maestroAgentNudge(maestro, agentCall, {
      countLiveWorkers: (missionId) => {
        calls += 1;
        expect(missionId).toBe('mission-1');
        return 4;
      },
    });
    expect(calls).toBe(1);
    expect(text).toContain('4 workers vivos');
  });
});
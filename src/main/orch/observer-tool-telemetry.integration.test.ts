// F-780 de ponta a ponta: o POST que o hook PreToolUse do pane faz em
// /hook/status vira quadro do observer, evento no journal da missão (SQLite
// real) e linha do events.jsonl — exatamente onde a auditoria de 03/10
// (06-uso-real.md, lacuna L1) procurou o nome da tool e não achou. Só o
// registro de sessões do pty-manager é dublado: ele diz de qual missão é o PTY.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const harness = vi.hoisted(() => ({
  session: null as null | {
    paneId: string;
    missionId: string;
    scope: ProjectExecutionScope;
  },
}));

vi.mock('../pty/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pty/pty-manager')>()),
  getAgentSessionInfo: (sessionId: string) =>
    sessionId === 'pty-f780' ? harness.session : null,
  getSessionState: () => 'idle',
  publishSessionActivityState: () => true,
}));

import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { __resetAgentStatusForTests } from './agent-status';
import { handleHookStatusRequest } from './hook-status-endpoint';
import { projectMissionToDisk } from './mission-disk-projection';
import { configureMissionEventEmit } from './mission-event-emit';
import { createScopedMissionStore } from './mission-store';
import { __resetObserverBusForTests } from './observer-bus';
import {
  installObserverMissionEventProjector,
  uninstallObserverMissionEventProjector,
} from './observer-mission-event-projector';

let baseDir = '';
let runtimeManager: ProjectRuntimeManager | null = null;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f780-telemetry-'));
  __resetAgentStatusForTests();
  __resetObserverBusForTests();
});

afterEach(() => {
  uninstallObserverMissionEventProjector();
  configureMissionEventEmit(null);
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.missionEventJournal);
  runtimeManager?.closeAll();
  runtimeManager = null;
  harness.session = null;
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function postPreToolUse(body: Record<string, unknown>): void {
  const result = handleHookStatusRequest(
    { sessionId: 'pty-f780' },
    { eventType: 'tool-use', flavor: 'claude', body },
    undefined,
    () => {},
  );
  expect(result.statusCode).toBe(200);
}

describe('F-780: hook PreToolUse → events.jsonl da missão', () => {
  it('grava nome e categoria de cada tool chamada, sem argumento', () => {
    runtimeManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.76.191-test',
    });
    const scope = testProjectScope({ checkoutId: 'f780-telemetry' });
    const mission = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-f780',
    }).create({ title: 'Telemetria de tools' });
    harness.session = { paneId: 'pane-f780', missionId: mission.id, scope };
    configureMissionEventEmit(runtimeManager);
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.missionEventJournal,
      true,
    );
    installObserverMissionEventProjector();

    // Corpo real do PreToolUse do Claude Code (tool_name + tool_input).
    postPreToolUse({
      tool_name: 'WebFetch',
      tool_input: {
        url: 'https://docs.example.com/privado?token=abc',
        prompt: 'resuma a política interna',
      },
    });
    postPreToolUse({
      tool_name: 'mcp__nexus__nexus_browser_read',
      tool_input: { paneId: 'browser-1', format: 'compact' },
    });
    // Skill: o NOME da skill é rótulo e sai; os args não.
    postPreToolUse({
      tool_name: 'Skill',
      tool_input: { skill: 'Ponytail', args: '--token sk-proj-SEGREDO' },
    });
    // Shell que faz HTTP: só a categoria sai, nunca o comando.
    postPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'cd app && curl -sL https://intranet.example/relatorio?key=xyz | head' },
    });
    postPreToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } });

    const result = projectMissionToDisk(runtimeManager, scope, mission.id);
    expect(result).not.toBeNull();
    const events = fs.readFileSync(result!.eventsPath, 'utf8');
    const toolCalls = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.type === 'observer.tool_call');

    expect(events).toContain('"toolName":"WebFetch"');
    expect(toolCalls.map((line) => [line.toolName, line.toolKind, line.skillName])).toEqual([
      ['WebFetch', 'fetch', undefined],
      ['mcp__nexus__nexus_browser_read', 'nexus-browser', undefined],
      ['Skill', 'skill', 'ponytail'],
      ['Bash', 'shell-http', undefined],
      ['Bash', 'execute', undefined],
    ]);
    for (const leaked of [
      'docs.example.com',
      'token=abc',
      'política interna',
      'browser-1',
      'SEGREDO',
      '--token',
      'intranet.example',
      'key=xyz',
      'npm test',
    ]) {
      expect(events).not.toContain(leaked);
    }
  });
});

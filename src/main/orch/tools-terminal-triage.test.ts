import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  triage: vi.fn(),
  sandboxDir: vi.fn(() =>
    fs.mkdtempSync(path.join(os.tmpdir(), 'jev-triage-sbx-')),
  ),
}));

vi.mock('../jev/jev-terminal-triage', () => ({
  triageCommandFailure: h.triage,
}));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: vi.fn(() => ({})),
}));
vi.mock('./owned-command-launch', async () => ({ prepareOwnedCommandLaunch: (await import('./__tests__/owned-command-fixture')).groupFixtureLaunch }));
// Spawn real /bin/sh sem Seatbelt — o que está em teste é o pós-processamento
// do resultado (campo `triage`), não o plano de sandbox.
vi.mock('../runtime/process-sandbox', () => ({
  createScopedSandboxHome: () => ({ dir: h.sandboxDir() }),
  buildScopedShellPlan: (input: {
    command: string;
    cwd: string;
    env: Record<string, string>;
  }) => ({
    file: '/bin/sh',
    args: ['-c', input.command],
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    detached: false,
    profile: 'test',
  }),
}));

import { buildTerminalTools } from './tools-terminal';

const scope = testProjectScope({
  rootRealPath: fs.realpathSync(os.tmpdir()),
});
const ctx = {
  token: 't',
  label: 'worker',
  role: 'worker',
  missionId: 'm',
  sessionId: 'sess-1',
  scope,
  allowedTools: null,
  allowedSkills: null,
  stopAttempts: 0,
  handoffSubmitted: false,
} as AgentGateContext;

const tool = buildTerminalTools()[0];

describe('nexus_terminal_run — triagem Jev de falha', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const call of h.sandboxDir.mock.results) {
      const dir = call.value as string;
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('anexa `triage` quando o comando falha e a triagem responde', async () => {
    h.triage.mockResolvedValue({
      kind: 'flaky',
      confidence: 0.9,
      retryHelps: 0.8,
      model: 'jev-test',
    });
    const out = (await tool.handler(
      { command: "echo boom >&2; exit 3" },
      ctx,
    )) as { exitCode: number; triage?: { kind: string } };
    expect(out.exitCode).toBe(3);
    expect(out.triage).toMatchObject({ kind: 'flaky' });
    expect(h.triage).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: 3 }),
      expect.objectContaining({}),
    );
  });

  it('sem triagem quando o comando tem sucesso', async () => {
    const out = (await tool.handler({ command: 'exit 0' }, ctx)) as {
      exitCode: number;
      triage?: unknown;
    };
    expect(out.exitCode).toBe(0);
    expect(out.triage).toBeUndefined();
    expect(h.triage).not.toHaveBeenCalled();
  });

  it('sem triagem quando a triagem retorna null', async () => {
    h.triage.mockResolvedValue(null);
    const out = (await tool.handler({ command: 'exit 1' }, ctx)) as {
      exitCode: number;
      triage?: unknown;
    };
    expect(out.exitCode).toBe(1);
    expect(out.triage).toBeUndefined();
  });
});

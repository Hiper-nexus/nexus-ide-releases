import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell';
import { primeSystemMemoryCacheForTest } from './pane-admission';

vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({ squadCliPolicy: 'operator-choice' }) }));
vi.mock('../runtime/process-sandbox', () => ({
  createScopedSandboxHome: () => ({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-shell-home-')) }),
  buildScopedShellPlan: (input: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
    file: '/bin/sh', args: ['-c', input.command], cwd: input.cwd, env: { ...process.env, ...input.env }, detached: true,
  }),
}));
vi.mock('../jev/jev-terminal-triage', () => ({ triageCommandFailure: async () => null }));
vi.mock('./bg-task-events', () => ({ emitBgTaskEvent: () => {} }));
vi.mock('./owned-command-launch', async () => ({ prepareOwnedCommandLaunch: (await import('./__tests__/owned-command-fixture')).groupFixtureLaunch }));
import { buildTerminalTools } from './tools-terminal';
import { buildBgTools } from './tools-bg';
import { heavyCommandPermitSnapshot } from './heavy-command-permit';

let dir: string;
let ctx: AgentGateContext;
const quote = (value: string) => quoteStartupArg(value, 'posix');
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-command-')));
  ctx = { token: 'worker', label: 'Worker', role: 'worker', missionId: 'mission', sessionId: 'session',
    scope: testProjectScope({ rootRealPath: dir }), allowedTools: null, allowedSkills: null,
    stopAttempts: 0, handoffSubmitted: false };
  primeSystemMemoryCacheForTest({ freeMB: 30_000, swapUsedMB: 0 });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function script(name: string, body: string): string {
  const folder = path.join(dir, name); fs.mkdirSync(folder);
  const file = path.join(folder, 'tsc'); fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); return quote(file);
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('physical command fixture deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it.runIf(process.platform !== 'win32').each(['mission', 'loose helper'])('serializes real foreground/background launches for %s', async scenario => {
  if (scenario === 'loose helper') { ctx.missionId = undefined; ctx.role = 'user'; ctx.operatorParentSessionId = 'operator'; }
  const log = path.join(dir, 'order'); const firstGate = path.join(dir, 'first-gate'); const secondGate = path.join(dir, 'second-gate');
  const first = script('first', `printf 'first-start\\n' >> ${quote(log)}\nwhile ! test -e ${quote(firstGate)}; do sleep .05; done\nprintf 'first-end\\n' >> ${quote(log)}`);
  const second = script('second', `printf 'second-start\\n' >> ${quote(log)}\nwhile ! test -e ${quote(secondGate)}; do sleep .05; done`);
  const run = buildTerminalTools().find(t => t.name === 'nexus_terminal_run')!;
  const bg = buildBgTools().find(t => t.name === 'nexus_bg_run')!;
  const wait = buildBgTools().find(t => t.name === 'nexus_bg_wait')!;
  const secondContext = { ...ctx, token: 'second', sessionId: 'second-session' };
  const firstFlight = run.handler({ command: first, timeoutMs: 3000 }, ctx);
  await until(() => fs.existsSync(log));
  const secondFlight = bg.handler({ command: second }, secondContext);
  try {
    await until(() => heavyCommandPermitSnapshot().waiting === 1 || fs.readFileSync(log, 'utf8').includes('second-start'));
    expect(fs.readFileSync(log, 'utf8')).toBe('first-start\n');
    fs.writeFileSync(firstGate, 'release'); await firstFlight; await secondFlight;
    await until(() => fs.readFileSync(log, 'utf8').includes('second-start'));
    expect(fs.readFileSync(log, 'utf8')).toBe('first-start\nfirst-end\nsecond-start\n');
  } finally {
    fs.writeFileSync(firstGate, 'release'); fs.writeFileSync(secondGate, 'release');
    await Promise.allSettled([firstFlight, secondFlight]);
    const result = await secondFlight as { taskId: string };
    await wait.handler({ taskId: result.taskId, timeoutMs: 3000 }, secondContext);
    await until(() => heavyCommandPermitSnapshot().active === 0);
  }
});

it.runIf(process.platform !== 'win32')('holds the slot after shell close while an owned process-group child still lives', async () => {
  const log = path.join(dir, 'group-order');
  const ready = path.join(dir, 'child-ready');
  const first = script('parent', `(trap '' TERM; printf ready > ${quote(ready)}; sleep .7) >/dev/null 2>&1 &\nwhile ! test -e ${quote(ready)}; do sleep .01; done\nprintf 'root-end\\n' >> ${quote(log)}`);
  const second = script('next', `printf 'next-start\\n' >> ${quote(log)}`);
  const run = buildTerminalTools().find(t => t.name === 'nexus_terminal_run')!;
  const firstFlight = run.handler({ command: first, timeoutMs: 3000 }, ctx);
  await until(() => fs.existsSync(log));
  const next = run.handler({ command: second, timeoutMs: 3000 }, { ...ctx, token: 'next', sessionId: 'next' });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(fs.readFileSync(log, 'utf8')).toBe('root-end\n');
    expect(heavyCommandPermitSnapshot().active).toBe(1);
  } finally { await Promise.all([firstFlight, next]); }
  expect(fs.readFileSync(log, 'utf8')).toBe('root-end\nnext-start\n');
});

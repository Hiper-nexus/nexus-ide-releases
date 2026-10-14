import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchPaneSpawnResult } from '../../shared/orch-types';
import type { AsyncGitRunner, GitResult } from '../runtime/git-command';
const deps = vi.hoisted(() => ({
  getPane: vi.fn(),
  spawnSync: vi.fn(() => ({ requestId: 'sync', ok: true, paneId: 'sync-pane', sessionId: 'sync-session' })),
  spawnAsync: vi.fn<(...args: unknown[]) => Promise<OrchPaneSpawnResult>>(),
  terminate: vi.fn(async () => true),
  sessionCwd: vi.fn((_sessionId: string): string | null => null),
  sessionInfo: vi.fn((_sessionId: string): Record<string, unknown> | null => null),
  trace: vi.fn(),
  markClosed: vi.fn(),
  stores: vi.fn(),
  worktrees: vi.fn(),
  /** F-1473: o substituto sem prova sai sem deixar pane morto. */
  deletePane: vi.fn(() => true),
  /** F-822: nada de processo síncrono no caminho do failover. */
  execFileSync: vi.fn(() => { throw new Error('execFileSync no caminho do failover'); }),
  spawnSyncChild: vi.fn(() => { throw new Error('spawnSync no caminho do failover'); }),
}));
const advisor = vi.hoisted(() => ({ scheduleRecoveryAdvice: vi.fn() }));
vi.mock('./jev-mission-advisor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-mission-advisor')>()),
  scheduleRecoveryAdvice: advisor.scheduleRecoveryAdvice,
}));
vi.mock('./main-owned-pane-runtime', () => ({ getMainOwnedPane: deps.getPane, deleteMainOwnedPane: deps.deletePane }));
vi.mock('./pane-registry', () => ({
  spawnMainOwnedMissionPane: deps.spawnSync,
  spawnMainOwnedMissionPaneAsync: deps.spawnAsync,
}));
/** F-1473: sessões físicas que a prova da retomada observa. */
type FakeSession = { paneId: string; spawnedAt: number; resumed: boolean };
const pty = vi.hoisted(() => ({
  taps: new Set<(id: string, agent: { paneId?: string } | null, rootExit: { exitCode: number } | null) => void>(),
  sessions: new Map<string, { paneId: string; spawnedAt: number; resumed: boolean }>(),
  /** Sessões cujo fim foi pedido pelo Nexus (`getRequestedTerminationOrigin`). */
  requested: new Set<string>(),
}));
vi.mock('../pty/pty-manager', () => ({
  orchTerminateSession: deps.terminate,
  getSessionCwd: deps.sessionCwd,
  getAgentSessionInfo: deps.sessionInfo,
  getRequestedTerminationOrigin: (id: string) => (pty.requested.has(id) ? 'pane-close' : null),
  tapSessionTermination: (cb: (id: string, agent: { paneId?: string } | null, rootExit: { exitCode: number } | null) => void) => {
    pty.taps.add(cb);
    return () => pty.taps.delete(cb);
  },
  getSessionState: (id: string) => (pty.sessions.has(id) ? 'busy' : null),
  getSessionSpawnedAtMs: (id: string) => pty.sessions.get(id)?.spawnedAt ?? null,
  getSessionProviderConversation: (id: string) =>
    pty.sessions.has(id) ? { resumed: pty.sessions.get(id)!.resumed } : null,
  listAgentSessionsForPane: (paneId: string) =>
    [...pty.sessions].filter(([, session]) => session.paneId === paneId).map(([sessionId]) => ({ sessionId, paneId })),
}));
vi.mock('../observability/main-trace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability/main-trace')>()),
  trace: deps.trace,
}));
vi.mock('./pane-session-output', () => ({ markPaneDeliberatelyClosed: deps.markClosed }));
vi.mock('./project-domain-store-registry', () => ({ getProjectDomainStores: deps.stores }));
vi.mock('../runtime/worktree-runtime-registry', () => ({
  requireWorktreeRuntimeRegistry: deps.worktrees,
}));
// F-1476: o canal do argv de cada CLI vem do manifesto builtin real.
vi.mock('../adapters/adapter-registry', async (importOriginal) => {
  const { BUILTIN_ADAPTERS } = await import('../../adapters/builtin');
  const { adapterSchema } = await import('../../shared/adapter-types');
  return {
    ...(await importOriginal<typeof import('../adapters/adapter-registry')>()),
    getAdapter: (id: string) => {
      const raw = BUILTIN_ADAPTERS.find((entry) => (entry as { id?: unknown }).id === id);
      return raw ? adapterSchema.parse(raw) : null;
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: deps.execFileSync,
  spawnSync: deps.spawnSyncChild,
}));

/** Git falso e hermético: responde por subcomando e guarda cada chamada. */
function fakeGit(overrides: Partial<Record<'config' | 'status' | 'diff', GitResult | Error>> = {}) {
  const calls: Array<{ cwd: string; args: readonly string[]; timeoutMs?: number }> = [];
  const runner: AsyncGitRunner = {
    run: async (cwd, args, options = {}) => {
      calls.push({ cwd, args, timeoutMs: options.timeoutMs });
      const sub = args[0] as 'config' | 'status' | 'diff';
      const answer = overrides[sub] ?? {
        config: { status: 1, stdout: '', stderr: '' },
        status: { status: 0, stdout: ' M src/a.ts\n?? src/novo.ts\n', stderr: '' },
        diff: { status: 0, stdout: ' src/a.ts | 3 ++-\n', stderr: '' },
      }[sub];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { runner, calls };
}

let tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

import {
  GIT_STATE_TIMEOUT_MS,
  collectGitTaskState,
  planMainOwnedFailoverRespawn,
  respawnBriefNeedsPaste,
  respawnMainOwnedPaneWithAccount,
  observeResumeBoot,
  type ResumeBootObserver,
  type ResumeBootVerdict,
} from './failover-mission-respawn';
import {
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
} from '../../shared/failover-handoff';
import { maskAccountLabel } from '../../shared/account-choice';
import { detectLimit } from './limit-detector';
import { createVisualTaskRequirement, visualTaskAtSpawn } from './visual-handoff-gate';
import { CONTEXT_HANDOFF_BUDGET_ERROR } from './context-handoff-budget';
import { forgetPaneTaskReroute, getPaneTaskReroute, registerPaneTaskReroute } from './pane-task-reroute';
import { onFailoverRetirementVerdict } from './failover-retirement';
import { quarantineRejectedModel, resetModelAccessQuarantineForTests } from './model-access-quarantine';
import { inFlightRequestOf, inFlightRequestsOf, noteInFlightRequest, resetInFlightRequestsForTests } from './in-flight-request';
import { FailoverTextReducer, type FailoverTextProposal } from './failover-text-core';
import { inkWrap } from '../../shared/__tests__/synthetic-secrets';

/** Formatos REAIS que o detector reconhece: cada linha sozinha dispara. */
const LIVE_LIMIT_LINES = [
  'Error: model_not_found',
  'not_found_error: model: claude-x',
  'models/gemini-9-pro is not found',
  "The model 'gpt-x' does not exist or you do not have access to it",
  "The 'gpt-6' model requires a newer version of Codex.",
  'insufficient_quota',
  'Your credit balance is too low',
  'usage limit reached',
  "You've hit your session limit · resets 8:10pm",
  'API Error: 429',
  'HTTP 401 Unauthorized',
  'rate_limit_exceeded',
  'RateLimitError',
  'RESOURCE_EXHAUSTED',
  'overloaded_error',
  '503 Service Unavailable',
  'Your quota will reset after 2h',
  'usage_limit_reached',
  'limit_reached: true',
  'internal_server_error:',
  "■ unexpected status 400: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
  'too many requests',
  'limite de uso atingido',
  '额度不足',
  'Upstream request failed: Model access is disabled',
];

/** Inertes inteiros, mas disparam numa janela que corta o texto ou junta linhas. */
const WINDOW_LIMIT_TRAPS: ReadonlyArray<readonly [string, string]> = [
  ['id=xmodel_not_found;', 'model_not_found;'],
  ['> Error: 429', 'Error: 429'],
  ['veja `error: 429` aqui', 'error: 429` aqui'],
  ['Output: rate_limit_exceeded', 'rate_limit_exceeded'],
  ['codex usage\nOutput: detalhes\nlimit reached', 'codex usage\nOutput: detalhes\nlimit reached'],
  ['codex usage\nAccount "x" hit a provider limit (kind quota).\nlimit reached', 'codex usage\nAccount "x" hit a provider limit (kind quota).\nlimit reached'],
  ['error Rate limited… 429', 'error Rate limited… 429'],
];

const meta = {
  missionId: 'mission-1',
  role: 'worker' as const,
  agentName: 'Implementar motor',
  contextRevision: 'rev-1',
  allowedTools: null,
  allowedSkills: [],
  readOnly: false,
};

describe('planMainOwnedFailoverRespawn (failover de conta em pane de missão)', () => {
  it('F-885 preserves the Main visual assignment through generic model-rotation prompts', () => {
    const visualTask = createVisualTaskRequirement(1000, 'ui-assignment');
    const plan = planMainOwnedFailoverRespawn({ adapterId: 'claude', meta: { ...meta, visualTask },
      toModel: 'claude-sonnet-5-5', fromAccountLabel: 'fixture', reason: 'model rejected' });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    expect(visualTaskAtSpawn(plan.options)).toEqual(visualTask);
  });
  it('planeia respawn com a nova conta pinada e pacote de continuidade (F-775)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta,
      toAccountId: 'acct-2',
      toAccountLabel: 'ana.ops@example.org',
      fromAccountLabel: 'gustavo.lupygo@example.com',
      reason: 'rate limit exceeded',
      limitKind: 'rate-limit',
      limitWindow: '5 Horas',
      limitResetsAt: Date.UTC(2026, 9, 3, 18, 0, 0),
      taskBrief: 'Fechar o builder do pack',
      nextStep: 'Rodar os testes do pack',
      touchedFiles: ['src/shared/failover-handoff.ts'],
      diffStat: 'src/shared/failover-handoff.ts | 10 ++++++',
      scrollbackExcerpt: 'boot\n…\nAPI Error: 401 Unauthorized\ndied here',
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    // Conta pinada = recibo account-choice com source 'pinned'
    // (resolveSpawnAccountChoice grava 'pinned' quando accountId é explícito).
    expect(plan.options.accountId).toBe('acct-2');
    expect(plan.options.missionId).toBe('mission-1');
    expect(plan.options.role).toBe('worker');
    expect(plan.options.agentName).toBe('Implementar motor');
    const prompt = plan.options.initialPrompt ?? '';
    expect(prompt.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(prompt.endsWith(FAILOVER_HANDOFF_FOOTER)).toBe(true);
    expect(prompt).toContain(maskAccountLabel('gustavo.lupygo@example.com'));
    expect(prompt).toContain(maskAccountLabel('ana.ops@example.org'));
    expect(prompt).not.toContain('gustavo.lupygo@example.com');
    expect(prompt).toContain('kind rate-limit');
    expect(prompt).toContain('window 5 Horas');
    expect(prompt).toContain('src/shared/failover-handoff.ts');
    expect(prompt).toContain('Fechar o builder do pack');
    expect(prompt).toContain('Rodar os testes do pack');
    expect(prompt).toContain('died here');
    // Anti-loop F-511: o pack não re-arma o detector.
    expect(detectLimit(prompt)).toBeNull();
    expect(detectLimit(prompt.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
    // encarnação NOVA: workerIncarnationId não é herdado do processo morto
    expect(plan.options.workerIncarnationId).toBeUndefined();
  });

  it('F-520: rotação de modelo mantém o prompt curto (sem pack cross-account)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta,
      toAccountId: 'acct-1',
      fromAccountLabel: 'Pessoal',
      reason: 'model requires a newer version',
      toModel: 'claude-sonnet-4-6',
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    expect(plan.options.initialPrompt).toContain('claude-sonnet-4-6');
    expect(plan.options.initialPrompt).not.toContain(FAILOVER_HANDOFF_HEADER);
  });

  it('pula pane sem missão (não é worker de missão main-owned)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta: { ...meta, missionId: undefined, role: undefined },
      toAccountId: 'acct-2',
      fromAccountLabel: 'Pessoal',
      reason: 'quota',
    });
    expect(plan).toMatchObject({ action: 'skip' });
  });

  it('ORC-05: troca de CLI leva o pack intacto + recorte com orçamento dentro da faixa do detector', () => {
    const pack = `${FAILOVER_HANDOFF_HEADER}\n${'Pedido corrente da troca de CLI. '.repeat(1_800)}\n${FAILOVER_HANDOFF_FOOTER}`;
    const body = pack.slice(0, pack.lastIndexOf(FAILOVER_HANDOFF_FOOTER));
    const terminal = Array.from({ length: 300 }, (_, i) => `saída ${i} ${'x'.repeat(90)}`).join('\n');
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'codex', toModel: 'gpt-5.5', meta, fromAccountLabel: 'fixture', reason: 'quota',
      continuityPack: pack, paneId: 'old-pane', originalRequest: 'Portar o ORC-05 para o Nexus',
      scrollbackExcerpt: `${terminal}\nAPI Error: 401 Unauthorized\nTOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123`,
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    const prompt = plan.options.initialPrompt ?? '';
    // Pedido corrente byte a byte intacto; histórico antes do único footer.
    expect(prompt.startsWith(body)).toBe(true);
    expect(prompt.endsWith(FAILOVER_HANDOFF_FOOTER)).toBe(true);
    expect(prompt.indexOf(FAILOVER_HANDOFF_FOOTER)).toBe(prompt.length - FAILOVER_HANDOFF_FOOTER.length);
    const history = prompt.slice(body.length);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(16_000);
    expect(history).toContain('Portar o ORC-05 para o Nexus');
    expect(history).toContain('previous pane: old-pane');
    expect(history).toContain('nexus_mission_get({missionId:"mission-1"})');
    expect(history).toMatch(/omitted [1-9]\d* items/);
    expect(history).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(detectLimit(prompt)).toBeNull();
    expect(detectLimit(prompt.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
  });

  it('ORC-05: estouro do orçamento pula o respawn com erro — o pack nunca é encurtado', () => {
    const pack = `${FAILOVER_HANDOFF_HEADER}\n${'p'.repeat(100_000)}\n${FAILOVER_HANDOFF_FOOTER}`;
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'codex', meta, fromAccountLabel: 'fixture', reason: 'quota', continuityPack: pack,
    });
    expect(plan.action).toBe('skip');
    if (plan.action !== 'skip') return;
    expect(plan.reason).toContain(CONTEXT_HANDOFF_BUDGET_ERROR);
  });

  it('ORC-05/F-249: nenhuma janela do prompt inteiro dispara o detector — sem depender do header', () => {
    for (const line of LIVE_LIMIT_LINES) expect(detectLimit(line), line).not.toBeNull();
    for (const [, cut] of WINDOW_LIMIT_TRAPS) expect(detectLimit(cut), cut).not.toBeNull();
    const filler = Array.from({ length: 40 }, (_, i) => `passo ${i}: compilando o módulo ${i} sem erro`).join('\n');
    const scrollback = [filler, ...LIVE_LIMIT_LINES, ...WINDOW_LIMIT_TRAPS.map(([trap]) => trap), filler].join('\n');
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'codex', meta, fromAccountLabel: 'fixture', reason: 'quota', paneId: 'old-pane',
      continuityPack: `${FAILOVER_HANDOFF_HEADER}\nContinue a tarefa na CLI nova.\n${FAILOVER_HANDOFF_FOOTER}`,
      originalRequest: 'Corrigir o erro model_not_found do pane antigo', scrollbackExcerpt: scrollback,
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    const prompt = plan.options.initialPrompt ?? '';
    expect(prompt).toContain('compilando o módulo 39');
    // O header nunca protege: some do texto e toda janela é varrida.
    const bare = prompt.replace(FAILOVER_HANDOFF_HEADER, '');
    expect(bare.length).toBeGreaterThan(4_000);
    const window = (start: number, end: number) => {
      const hit = detectLimit(bare.slice(start, end));
      if (hit) throw new Error(`janela ${start}-${end} disparou: ${hit.kind} ${hit.reason}`);
    };
    for (let start = 0; start < bare.length; start += 1) window(start, start + 4_000);
    for (let end = 1; end <= bare.length; end += 1) window(Math.max(0, end - 4_000), end);
    // Reducer real (o mesmo do failover), com cortes de chunk variados.
    for (const size of [7, 61, 1_999, 2_000, 2_001, 4_000, bare.length]) {
      const reducer = new FailoverTextReducer();
      const proposals: FailoverTextProposal[] = [];
      let at = 0;
      for (let offset = 0; offset < bare.length; offset += size) {
        at += 300;
        proposals.push(...reducer.feed(bare.slice(offset, offset + size), at));
      }
      proposals.push(...reducer.feed('', at + 300, true));
      expect(proposals.filter((proposal) => proposal.hit)).toEqual([]);
    }
  }, 300_000);

  it('F-999: motivo model_not_found na 2ª linha do pack não dispara em janela que começa no meio da linha', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude', meta, toAccountId: 'acct-2', fromAccountLabel: 'fixture',
      reason: 'model_not_found', limitKind: 'model', paneId: 'old-pane',
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    const prompt = plan.options.initialPrompt ?? '';
    expect(prompt).toContain('hit a provider limit');
    for (const echo of [prompt, inkWrap(prompt, 80)]) {
      for (let start = 1; start < echo.length; start += 1) {
        const hit = detectLimit(echo.slice(start, start + 4_000));
        if (hit) throw new Error(`janela em ${start} disparou ${hit.kind} (${hit.reason})`);
      }
    }
  });

  it('ORC-05: segredo atravessando a fronteira de 2.000 caracteres não sai em nenhum fragmento', () => {
    const pemBody = Array.from({ length: 40 }, () => `${'P3m'.repeat(21)}Q`);
    const promptFor = (scrollbackExcerpt: string) => {
      const plan = planMainOwnedFailoverRespawn({
        adapterId: 'claude', meta, toAccountId: 'acct-2', fromAccountLabel: 'fixture', reason: 'quota',
        paneId: 'old-pane', scrollbackExcerpt,
      });
      expect(plan.action).toBe('respawn');
      return plan.action === 'respawn' ? plan.options.initialPrompt ?? '' : '';
    };
    const prompt = promptFor([
      `${'a'.repeat(1_984)} sk-ant-api03-${'K7'.repeat(15)} fim`,
      `${'b'.repeat(1_983)} ghp_${'G5'.repeat(14)} fim`,
      `${'c'.repeat(1_977)} Authorization: Bearer ${'B9'.repeat(16)} fim`,
      '-----BEGIN RSA PRIVATE KEY-----',
      ...pemBody,
      '-----END RSA PRIVATE KEY-----',
      'depois da chave',
    ].join('\n'));
    for (const fragment of ['K7K7', 'G5G5', 'B9B9', 'P3mP3m']) expect(prompt).not.toContain(fragment);
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).toContain('depois da chave');
    // Cauda que começa no meio da chave: END sem BEGIN.
    const headless = promptFor([...pemBody.slice(10), '-----END RSA PRIVATE KEY-----', 'depois da chave'].join('\n'));
    expect(headless).not.toContain('P3mP3m');
    expect(headless).toContain('depois da chave');
  });

  it('pula meta ausente (pane main-owned não registrado)', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude',
      meta: null,
      toAccountId: 'acct-2',
      fromAccountLabel: 'Pessoal',
      reason: 'auth',
    });
    expect(plan).toMatchObject({ action: 'skip' });
  });
});

describe('respawnMainOwnedPaneWithAccount', () => {
  it('F-1166: agenda a dica de recuperação da missão do pane e segue o failover igual', async () => {
    advisor.scheduleRecoveryAdvice.mockClear();
    deps.terminate.mockResolvedValueOnce(false);
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta: { ...meta, missionId: 'mission-rec' } });
    const result = await respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toModel: 'fixture-model', fromAccountLabel: 'fixture', reason: 'model rejected', limitKind: 'quota' });
    expect(result).toBe(false);
    expect(advisor.scheduleRecoveryAdvice).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'mission-rec', triggerClass: 'quota', paneId: 'old-pane', adapterId: 'claude', switchingTo: 'model',
    }));
    // P1: o texto do detector (`reason`) nunca sai daqui.
    expect(JSON.stringify(advisor.scheduleRecoveryAdvice.mock.calls)).not.toContain('model rejected');
    advisor.scheduleRecoveryAdvice.mockClear();
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta: { ...meta, missionId: undefined } });
    await respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toModel: 'fixture-model', fromAccountLabel: 'fixture', reason: 'model rejected' });
    expect(advisor.scheduleRecoveryAdvice).not.toHaveBeenCalled();
  });

  it.each(['unproved', 'rejected'])('F-890 keeps the orchestrator without replacement when termination is %s', async (mode) => {
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta: { ...meta, role: 'orchestrator' } });
    deps.spawnAsync.mockResolvedValue({ requestId: 'unexpected', ok: true, paneId: 'unexpected', sessionId: 'unexpected' });
    if (mode === 'unproved') deps.terminate.mockResolvedValueOnce(false);
    else deps.terminate.mockRejectedValueOnce(new Error('fixture physical proof unavailable'));
    const result = await respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toModel: 'fixture-model', fromAccountLabel: 'fixture', reason: 'model rejected' });
    expect(result).toBe(false);
    expect(deps.spawnAsync).not.toHaveBeenCalled();
  });
  it.each(['unproved', 'rejected'])('F-890 keeps the worker at the pane cap without replacement when termination is %s', async (mode) => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'cap', ok: false, error: 'pane_admission_cap: Teto de 4 panes de agente atingido' });
    if (mode === 'unproved') deps.terminate.mockResolvedValueOnce(false);
    else deps.terminate.mockRejectedValueOnce(new Error('fixture physical proof unavailable'));
    const result = await respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toAccountId: 'account-b', fromAccountLabel: 'fixture', reason: 'quota' });
    expect(result).toBe(false);
    expect(deps.spawnAsync).toHaveBeenCalledTimes(1);
  });
  it.each(['removed', 'replaced', 'new-session'])('F-886 refuses %s owner after awaited Git facts', async (change) => {
    deps.spawnAsync.mockResolvedValue({ requestId: 'unexpected', ok: true, paneId: 'unexpected', sessionId: 'unexpected' });
    const worktree = tempDir('nexus-f886-worktree-');
    const shared = tempDir('nexus-f886-shared-');
    const entry = { entry: { paneId: 'old-pane', sessionId: 'old-session' },
      meta: { ...meta, scope: { rootRealPath: shared }, executionScope: { rootRealPath: worktree } } };
    deps.getPane.mockReturnValue(entry);
    let entered!: () => void;
    const captured = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runner: AsyncGitRunner = { run: async () => {
      entered(); await gate; return { status: 1, stdout: '', stderr: '' };
    } };
    const flight = respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toAccountId: 'fixture-account', fromAccountLabel: 'fixture', reason: 'quota' }, { git: runner });
    await captured;
    if (change === 'removed') deps.getPane.mockReturnValue(undefined);
    else if (change === 'replaced') deps.getPane.mockReturnValue({ ...entry, entry: { ...entry.entry } });
    else entry.entry.sessionId = 'new-session';
    release();
    expect(await flight).toBe(false);
    expect(deps.terminate).not.toHaveBeenCalled();
    expect(deps.spawnAsync).not.toHaveBeenCalled();
  });

  it('F-886 refuses manual closure during physical termination before creating a replacement', async () => {
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta: { ...meta, role: 'orchestrator' } });
    deps.spawnAsync.mockResolvedValue({ requestId: 'unexpected', ok: true, paneId: 'unexpected', sessionId: 'unexpected' });
    deps.terminate.mockImplementationOnce(async () => { deps.getPane.mockReturnValue(undefined); return true; });
    const flight = respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toModel: 'fixture-model', fromAccountLabel: 'fixture', reason: 'model rejected' });
    expect(await flight).toBe(false);
    expect(deps.spawnAsync).not.toHaveBeenCalled();
  });
  it('F-886/F-1480: manual closure while the worker replacement spawns refuses it and kills nothing', async () => {
    deps.spawnAsync.mockImplementationOnce(async (options) => {
      deps.getPane.mockReturnValue(undefined);
      try {
        (options as { assertOriginCurrent: () => void }).assertOriginCurrent();
      } catch (error) {
        return { requestId: 'stale', ok: false, error: (error as Error).message };
      }
      return { requestId: 'unexpected', ok: true, paneId: 'unexpected', sessionId: 'unexpected' };
    });
    const flight = respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toAccountId: 'account-b', fromAccountLabel: 'fixture', reason: 'quota' });
    expect(await flight).toBe(false);
    expect(deps.terminate).not.toHaveBeenCalled();
    expect(deps.markClosed).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    deps.spawnAsync.mockReset();
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta });
  });

  it('waits for the asynchronous account gate before reporting a successful failover', async () => {
    let release!: (result: OrchPaneSpawnResult) => void;
    deps.spawnAsync.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let finished = false;
    const result = respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', adapterId: 'codex', toAccountId: 'account-reserve',
      fromAccountLabel: 'synthetic', reason: 'quota',
    }).then((value) => { finished = true; return value; });
    expect(deps.spawnAsync).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-reserve', adapterId: 'codex' }));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    release({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(result).resolves.toBe(true);
    expect(finished).toBe(true);
  });

  it('ORC-05: o pedido guardado do spawn entra no recorte da troca de conta; F-520 não recebe recorte', async () => {
    registerPaneTaskReroute({
      paneId: 'old-pane', adapterId: 'claude', missionId: 'mission-1', role: 'worker',
      callerSessionId: 'maestro', routeTask: 'Implementar o motor de contexto com orçamento',
      lineageId: 'old-pane', operatorOpened: false, pinnedRuntime: false, generation: 0,
      reroute: async () => ({ ok: false, error: 'unused' }) as never, hasAlternative: () => false,
    });
    try {
      deps.spawnAsync.mockResolvedValue({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
      await expect(respawnMainOwnedPaneWithAccount({
        paneId: 'old-pane', adapterId: 'claude', toAccountId: 'account-b',
        fromAccountLabel: 'fixture', reason: 'quota', scrollbackExcerpt: 'último passo feito',
      })).resolves.toBe(true);
      const account = deps.spawnAsync.mock.calls[0]![0] as { initialPrompt: string };
      expect(account.initialPrompt).toContain('[Historical user; original_request; item=request]');
      expect(account.initialPrompt).toContain('Implementar o motor de contexto com orçamento');
      expect(account.initialPrompt).toContain('último passo feito');
      expect(account.initialPrompt).toContain('the account switch was already decided');

      await expect(respawnMainOwnedPaneWithAccount({
        paneId: 'old-pane', adapterId: 'claude', toModel: 'claude-sonnet-5-5',
        fromAccountLabel: 'fixture', reason: 'model rejected',
      })).resolves.toBe(true);
      const model = deps.spawnAsync.mock.calls[1]![0] as { initialPrompt: string };
      expect(model.initialPrompt).not.toContain('Historical context');
      expect(model.initialPrompt).not.toContain('Implementar o motor de contexto');
    } finally {
      forgetPaneTaskReroute('old-pane');
    }
  });

  it('ORC-05: recorte que não cabe recusa a troca antes de matar a sessão', async () => {
    deps.spawnAsync.mockResolvedValue({ requestId: 'unexpected', ok: true, paneId: 'unexpected', sessionId: 'unexpected' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', fromAccountLabel: 'fixture', reason: 'quota',
      continuityPack: `${FAILOVER_HANDOFF_HEADER}\n${'p'.repeat(100_000)}\n${FAILOVER_HANDOFF_FOOTER}`,
    })).resolves.toBe(false);
    expect(deps.terminate).not.toHaveBeenCalled();
    expect(deps.spawnAsync).not.toHaveBeenCalled();
  });

  it('reports an auth gate refusal as failed failover', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: false, error: 'auth refresh timeout' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', adapterId: 'codex', toAccountId: 'account-reserve',
      fromAccountLabel: 'synthetic', reason: 'quota',
    })).resolves.toBe(false);
    expect(deps.spawnSync).not.toHaveBeenCalled();
  });

  it('integração F-775: limite com 2 contas → pane novo recebe o pack e a conta pinada', async () => {
    // A conta EXPLÍCITA no spawn é o que faz o recibo nascer `source: 'pinned'`
    // (provider-config-spawn.test.ts); aqui se prova que a reserva é a pinada.
    const worktree = tempDir('nexus-f822-worktree-');
    const shared = tempDir('nexus-f822-shared-');
    deps.getPane.mockReturnValue({
      entry: { paneId: 'old-pane', sessionId: 'old-session' },
      meta: { ...meta, scope: { rootRealPath: shared }, executionScope: { rootRealPath: worktree } },
    });
    const git = fakeGit();
    deps.spawnAsync.mockResolvedValueOnce({
      requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session',
    });
    const ok = await respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane',
      sessionId: 'old-session',
      adapterId: 'claude',
      toAccountId: 'account-b',
      toAccountLabel: 'reserve@example.org',
      fromAccountLabel: 'primary@example.com',
      reason: "You've hit your session limit",
      limitKind: 'rate-limit',
      limitWindow: 'Sessão',
      limitResetsAt: Date.UTC(2026, 9, 3, 20, 0, 0),
      taskBrief: 'Continuar F-775',
      nextStep: 'Validar o pack com detectLimit',
      scrollbackExcerpt: 'working…\nusage limit reached\ndeath',
    }, { git: git.runner });
    expect(ok).toBe(true);
    // Só depois do spawn real o caller emite switched:true (F-249).
    expect(deps.spawnAsync).toHaveBeenCalledTimes(1);
    const options = deps.spawnAsync.mock.calls[0][0] as {
      accountId: string;
      adapterId: string;
      initialPrompt: string;
    };
    expect(options).toMatchObject({ accountId: 'account-b', adapterId: 'claude' });
    expect(options.initialPrompt).toContain(FAILOVER_HANDOFF_HEADER);
    expect(options.initialPrompt).toContain('Validar o pack com detectLimit');
    expect(options.initialPrompt).toContain('- src/a.ts');
    expect(options.initialPrompt).toContain('- src/novo.ts');
    expect(options.initialPrompt).toContain('src/a.ts | 3 ++-');
    expect(detectLimit(options.initialPrompt)).toBeNull();
    // F-822: o git rodou só na worktree do pane, assíncrono e no envelope seguro.
    expect(git.calls.map((call) => call.cwd)).toEqual([worktree, worktree, worktree]);
    expect(deps.execFileSync).not.toHaveBeenCalled();
    expect(deps.spawnSyncChild).not.toHaveBeenCalled();
    // F-1480: o worker ganha o pane novo ANTES de a sessão exausta sair.
    expect(deps.terminate).toHaveBeenCalledWith(
      'old-session',
      expect.objectContaining({ origin: 'failover-respawn' }),
    );
    expect(deps.spawnAsync.mock.invocationCallOrder[0])
      .toBeLessThan(deps.terminate.mock.invocationCallOrder[0]!);
  });

});

describe('F-1480: troca de conta do worker headless não destrói estado', () => {
  const verdicts: Array<[string, boolean]> = [];
  let stopVerdicts: () => void = () => {};
  const recorded: unknown[] = [];
  const bound: unknown[] = [];
  const rebind = vi.fn();
  let worktree = '';
  let shared = '';
  const previousRow = {
    id: 'mpane-old', missionId: 'mission-1', adapterId: 'claude', model: 'claude-opus-x',
    accountId: 'account-a', cwd: undefined as string | undefined, title: 'Implementar motor',
    agentName: 'Implementar motor', workerIncarnationId: 'workerinc-old', role: 'worker' as const,
    paneId: 'old-pane', allowedTools: ['nexus_handoff_submit'], allowedSkills: [], readOnly: false,
    executionScope: {} as Record<string, unknown>, visualTask: undefined, operatorOpened: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    deps.spawnAsync.mockReset();
    verdicts.length = 0;
    recorded.length = 0;
    bound.length = 0;
    stopVerdicts = onFailoverRetirementVerdict((sessionId, replaced) => { verdicts.push([sessionId, replaced]); });
    worktree = tempDir('nexus-f1480-worktree-');
    shared = tempDir('nexus-f1480-shared-');
    previousRow.executionScope = { rootRealPath: worktree };
    const oldEntry = {
      entry: { paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude', accountId: 'account-a' },
      meta: { ...meta, workerIncarnationId: 'workerinc-old', scope: { rootRealPath: shared },
        executionScope: { rootRealPath: worktree } },
    };
    deps.getPane.mockImplementation((paneId: string) => paneId === 'old-pane' ? oldEntry
      : paneId === 'new-pane' ? {
        entry: { paneId: 'new-pane', sessionId: 'new-session', adapterId: 'claude', accountId: 'account-b' },
        meta: { ...meta, workerIncarnationId: 'workerinc-new', authoritySeal: undefined },
      } : undefined);
    deps.sessionCwd.mockImplementation((sessionId: string) =>
      sessionId === 'old-session' ? path.join(worktree, 'packages', 'app') : null);
    rebind.mockReset();
    deps.stores.mockReturnValue({ missionPanes: {
      findByPaneId: (paneId: string) => paneId === 'old-pane' ? previousRow : null,
      record: (row: unknown) => { recorded.push(row); return row; },
    }, taskDispatches: {
      list: () => [
        { taskId: 'task-other', revision: 1, state: 'running', paneId: 'other-pane', sessionId: 'other-session', workerIncarnationId: 'workerinc-other' },
        { taskId: 'task-1', revision: 4, state: 'running', paneId: 'old-pane', sessionId: 'old-session', workerIncarnationId: 'workerinc-old' },
      ],
      rebindRestartedWorker: rebind,
    } });
    deps.worktrees.mockReturnValue({
      findPaneWriter: (_scope: unknown, by: { paneId?: string }) =>
        by.paneId === 'old-pane' ? { missionId: 'mission-1', taskId: 'pane-writer-1' } : null,
      bindPaneWriter: (...args: unknown[]) => { bound.push(args); },
    });
    registerPaneTaskReroute({
      paneId: 'old-pane', adapterId: 'claude', missionId: 'mission-1', role: 'worker',
      callerSessionId: 'maestro', routeTask: 'Implementar o motor', lineageId: 'lineage-original',
      operatorOpened: false, pinnedRuntime: false, generation: 1,
      reroute: async () => ({ ok: false, error: 'unused' }) as never, hasAlternative: () => false,
    });
  });
  afterEach(() => {
    stopVerdicts();
    forgetPaneTaskReroute('old-pane');
    forgetPaneTaskReroute('new-pane');
    deps.getPane.mockReset();
    deps.sessionCwd.mockReset();
    deps.sessionInfo.mockReset();
    deps.stores.mockReset();
    deps.worktrees.mockReset();
    resetModelAccessQuarantineForTests();
  });

  const switchAccount = (git = fakeGit()) => respawnMainOwnedPaneWithAccount({
    paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude', toAccountId: 'account-b',
    fromAccountLabel: 'fixture-a', reason: 'usage limit', limitKind: 'rate-limit',
  }, { git: git.runner });

  it('troca não gera morte nem handoff failed; cwd, worktree e linhagem seguem no pane novo', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    const git = fakeGit();
    await expect(switchAccount(git)).resolves.toBe(true);
    const options = deps.spawnAsync.mock.calls[0]![0] as { cwd?: string; accountId?: string; workerIncarnationId?: string };
    // A subpasta real (e a pasta `projects/<cwd>` do Claude) segue no pane novo.
    expect(options.cwd).toBe(path.join(worktree, 'packages', 'app'));
    expect(options.accountId).toBe('account-b');
    expect(options.workerIncarnationId).toMatch(/^workerinc-/);
    expect(options.workerIncarnationId).not.toBe('workerinc-old');
    // Pane novo antes; a velha sai marcada como fechamento pedido (fora do breaker).
    expect(deps.spawnAsync.mock.invocationCallOrder[0]).toBeLessThan(deps.markClosed.mock.invocationCallOrder[0]!);
    expect(deps.markClosed).toHaveBeenCalledWith('old-pane');
    expect(deps.markClosed.mock.invocationCallOrder[0]).toBeLessThan(deps.terminate.mock.invocationCallOrder[0]!);
    expect(deps.terminate).toHaveBeenCalledWith('old-session', expect.objectContaining({ origin: 'failover-respawn' }));
    // Veredito para a cobrança de handoff: houve pane novo, nada de `failed`.
    expect(verdicts).toEqual([['old-session', true]]);
    // Nenhum git que muda a worktree: só config/status/diff de leitura.
    expect(git.calls.map((call) => call.args[0]).sort()).toEqual(['config', 'diff', 'status']);
    // O pane novo entra na composição com a seleção física do Main.
    expect(recorded).toEqual([expect.objectContaining({
      missionId: 'mission-1', paneId: 'new-pane', adapterId: 'claude', accountId: 'account-b',
      workerIncarnationId: 'workerinc-new', title: 'Implementar motor', role: 'worker',
      executionScope: { rootRealPath: worktree }, allowedTools: ['nexus_handoff_submit'],
    })]);
    // Supervisor e retomadas acham o pane novo: mesma linhagem, mesma geração.
    expect(getPaneTaskReroute('old-pane')).toBeNull();
    expect(getPaneTaskReroute('new-pane')).toMatchObject({
      paneId: 'new-pane', lineageId: 'lineage-original', generation: 1, routeTask: 'Implementar o motor',
    });
    expect(bound).toEqual([[{ rootRealPath: shared }, 'mission-1', 'pane-writer-1',
      { paneId: 'new-pane', sessionId: 'new-session' }]]);
  });

  it('spawn novo falha → a sessão de antes segue viva com a tarefa', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: false, error: 'auth refresh timeout' });
    await expect(switchAccount()).resolves.toBe(false);
    expect(deps.terminate).not.toHaveBeenCalled();
    expect(deps.markClosed).not.toHaveBeenCalled();
    expect(verdicts).toEqual([]);
    expect(recorded).toEqual([]);
    expect(getPaneTaskReroute('old-pane')).toMatchObject({ paneId: 'old-pane' });
  });

  it('terminação sem prova não desfaz a troca: o pane novo segue e a saída tardia é desculpada', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    deps.terminate.mockResolvedValueOnce(false);
    await expect(switchAccount()).resolves.toBe(true);
    expect(verdicts).toEqual([['old-session', true]]);
    expect(recorded).toHaveLength(1);
  });

  it.each([
    ['teto de panes', 'pane_admission_cap: Teto de 4 panes de agente atingido'],
    ['licença', 'license_agent_limit: Você já está usando os 2 agentes do teste. Feche um para abrir outro ou assine o Pro.'],
  ])('no %s a troca é uma por uma: a velha sai com prova e o pane novo nasce na vaga', async (_label, error) => {
    deps.spawnAsync
      .mockResolvedValueOnce({ requestId: 'seat', ok: false, error })
      .mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(switchAccount()).resolves.toBe(true);
    expect(deps.spawnAsync).toHaveBeenCalledTimes(2);
    expect(deps.terminate.mock.invocationCallOrder[0]).toBeGreaterThan(deps.spawnAsync.mock.invocationCallOrder[0]!);
    expect(deps.terminate.mock.invocationCallOrder[0]).toBeLessThan(deps.spawnAsync.mock.invocationCallOrder[1]!);
    expect(deps.terminate).toHaveBeenCalledTimes(1);
    expect(verdicts).toEqual([['old-session', true]]);
  });

  it('no teto, se o pane novo não nascer, a saída da velha volta a ser cobrada', async () => {
    deps.spawnAsync
      .mockResolvedValueOnce({ requestId: 'seat', ok: false, error: 'pane_admission_memory: Memória sem folga' })
      .mockResolvedValueOnce({ requestId: 'async', ok: false, error: 'auth refresh timeout' });
    await expect(switchAccount()).resolves.toBe(false);
    expect(verdicts).toEqual([['old-session', false]]);
    expect(recorded).toEqual([]);
    expect(rebind).not.toHaveBeenCalled();
  });

  it('o pane novo nasce no MESMO modelo e esforço da sessão física anterior, não no padrão', async () => {
    deps.sessionInfo.mockImplementation((sessionId: string) =>
      sessionId === 'old-session' ? { requestedModel: 'claude-sonnet-x', model: 'claude-sonnet-x-20260101', effort: 'high' } : null);
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(switchAccount()).resolves.toBe(true);
    expect(deps.spawnAsync.mock.calls[0]![0]).toMatchObject({
      accountId: 'account-b', model: 'claude-sonnet-x', effort: 'high',
    });
    expect(recorded).toEqual([expect.objectContaining({ model: 'claude-sonnet-x', effort: 'high' })]);
    expect(deps.trace).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'model-unavailable-on-account' }));
  });

  it('sem sessão física, modelo e esforço vêm da linha da composição', async () => {
    Object.assign(previousRow, { effort: 'medium' });
    try {
      deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
      await expect(switchAccount()).resolves.toBe(true);
      expect(deps.spawnAsync.mock.calls[0]![0]).toMatchObject({ model: 'claude-opus-x', effort: 'medium' });
    } finally {
      Object.assign(previousRow, { effort: undefined });
    }
  });

  it('modelo que a conta nova já recusou cai no padrão do adapter, com trace', async () => {
    deps.sessionInfo.mockReturnValue({ requestedModel: 'claude-opus-x', effort: 'high' });
    quarantineRejectedModel('claude', 'claude-opus-x', 'model access disabled', Date.now(), undefined,
      { accountId: 'account-b' });
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(switchAccount()).resolves.toBe(true);
    const options = deps.spawnAsync.mock.calls[0]![0] as { model?: string; effort?: string };
    expect(options.model).toBeUndefined();
    expect(options.effort).toBe('high');
    expect(deps.trace).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'account-failover', outcome: 'model-unavailable-on-account', paneId: 'old-pane',
      adapterId: 'claude', toAccountId: 'account-b', fromModel: 'claude-opus-x', toModel: null,
    }));
  });

  it('troca de CLI não herda modelo nem esforço da CLI anterior', async () => {
    deps.sessionInfo.mockReturnValue({ requestedModel: 'claude-opus-x', effort: 'high' });
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', fromAccountLabel: 'fixture',
      reason: 'quota', continuityPack: `${FAILOVER_HANDOFF_HEADER}\npack\n${FAILOVER_HANDOFF_FOOTER}`,
    })).resolves.toBe(true);
    const options = deps.spawnAsync.mock.calls[0]![0] as { adapterId: string; model?: string; effort?: string };
    expect(options).toMatchObject({ adapterId: 'codex' });
    expect(options.model).toBeUndefined();
    expect(options.effort).toBeUndefined();
  });

  it('F-1512: a tarefa despachada passa ao pane novo logo depois do spawn, antes de a sessão exausta sair', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(switchAccount()).resolves.toBe(true);
    const minted = (deps.spawnAsync.mock.calls[0]![0] as { workerIncarnationId: string }).workerIncarnationId;
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(rebind).toHaveBeenCalledWith({
      missionId: 'mission-1', paneId: 'old-pane', expectedSessionId: 'old-session',
      workerIncarnationId: 'workerinc-old', expectedTaskId: 'task-1', expectedRevision: 4,
      replacementSessionId: 'new-session', replacementPaneId: 'new-pane',
      replacementWorkerIncarnationId: minted, leaseMs: expect.any(Number),
    });
    expect(rebind.mock.invocationCallOrder[0]).toBeLessThan(deps.terminate.mock.invocationCallOrder[0]!);
  });

  it('rebind recusado (CAS) não desfaz a troca: o pane novo segue', async () => {
    rebind.mockImplementationOnce(() => { throw new Error('rebind do worker perdeu CAS do dispatch'); });
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'async', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(switchAccount()).resolves.toBe(true);
    expect(verdicts).toEqual([['old-session', true]]);
  });
});

describe('F-1473: troca de conta Claude continua a MESMA conversa no worker main-owned', () => {
  const scopedMeta = {
    ...meta,
    scope: { version: 1 as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/project', identitySource: 'manifest' as const },
  };
  const switchInput = {
    paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude',
    toAccountId: 'acct-b', toAccountLabel: 'ana.ops@example.org', fromAccountId: 'acct-a',
    fromAccountLabel: 'gustavo@example.com', reason: "You've hit your session limit", limitKind: 'rate-limit',
    taskBrief: 'Continuar F-1473', scrollbackExcerpt: 'trabalho em curso\nusage limit reached',
    touchedFiles: [] as string[], diffStat: undefined,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    deps.spawnAsync.mockReset();
    deps.terminate.mockResolvedValue(true);
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta: scopedMeta });
  });

  it('planeia o resume nativo do pane antigo na conta nova com só a nota curta', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude', meta: scopedMeta, paneId: 'old-pane', nativeResume: true,
      toAccountId: 'acct-b', toAccountLabel: 'ana.ops@example.org', fromAccountLabel: 'gustavo@example.com',
      reason: 'usage limit reached', scrollbackExcerpt: 'trecho que não vai junto', originalRequest: 'Implementar o motor',
    });
    expect(plan.action).toBe('respawn');
    if (plan.action !== 'respawn') return;
    expect(plan.options).toMatchObject({ accountId: 'acct-b', resume: true, resumeFromPaneId: 'old-pane' });
    const prompt = plan.options.initialPrompt ?? '';
    expect(prompt.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(prompt.endsWith(FAILOVER_HANDOFF_FOOTER)).toBe(true);
    expect(prompt).toContain('resumed THIS SAME conversation');
    expect(prompt).toContain(maskAccountLabel('ana.ops@example.org'));
    expect(prompt).toContain('Request in flight: Implementar o motor');
    expect(prompt).not.toContain('NEW provider session');
    expect(prompt).not.toContain('Historical context');
    expect(prompt).not.toContain('trecho que não vai junto');
    expect(detectLimit(prompt)).toBeNull();
    expect(detectLimit(prompt.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
  });

  it('troca de CLI ou de modelo nunca retoma a conversa', () => {
    for (const extra of [{ continuityPack: `${FAILOVER_HANDOFF_HEADER}\npack\n${FAILOVER_HANDOFF_FOOTER}` }, { toModel: 'claude-sonnet-5-5' }]) {
      const plan = planMainOwnedFailoverRespawn({
        adapterId: 'claude', meta: scopedMeta, paneId: 'old-pane', nativeResume: true,
        toAccountId: 'acct-b', fromAccountLabel: 'x', reason: 'quota', ...extra,
      });
      expect(plan.action).toBe('respawn');
      if (plan.action !== 'respawn') continue;
      expect(plan.options).not.toHaveProperty('resumeFromPaneId');
      expect(plan.options).not.toHaveProperty('resume');
    }
  });

  it('conta A → B: religa a conversa, sobe UM pane com --resume e a nota, e só depois reporta a troca', async () => {
    const rebindSession = vi.fn(() => true);
    const boot = fakeBoot('proved');
    const deliverResumeNote = vi.fn(async () => true);
    deps.sessionCwd.mockReturnValueOnce('/project/packages/web');
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(respawnMainOwnedPaneWithAccount({ ...switchInput, nativeResume: true },
      { rebindSession, observeResumeBoot: boot.observe, deliverBrief: deliverResumeNote })).resolves.toBe(true);
    // F-1476: a retomada não leva prompt no argv — a nota é colada com prova.
    expect(deliverResumeNote).toHaveBeenCalledWith('new-session', expect.stringContaining('resumed THIS SAME conversation'), 'claude');
    expect(rebindSession).toHaveBeenCalledWith(scopedMeta.scope, 'old-pane', 'claude', 'acct-a', 'acct-b');
    expect(deps.terminate).toHaveBeenCalledWith('old-session', expect.objectContaining({ origin: 'failover-respawn' }));
    expect(deps.spawnAsync).toHaveBeenCalledTimes(1);
    const options = deps.spawnAsync.mock.calls[0]![0] as { initialPrompt: string; resume?: boolean; resumeFromPaneId?: string; accountId?: string };
    // O --resume do Claude acha a conversa pela pasta do cwd: o pane nasce no mesmo lugar.
    expect(options).toMatchObject({ accountId: 'acct-b', resume: true, resumeFromPaneId: 'old-pane', cwd: '/project/packages/web' });
    expect(options.initialPrompt).toContain('resumed THIS SAME conversation');
    expect(options.initialPrompt).not.toContain('Recent terminal excerpt');
    expect(boot.confirm).toHaveBeenCalledWith({ sessionId: 'new-session', paneId: 'new-pane' });
    // O observador nasce antes do spawn (a saída no boot não escapa) e é descartado.
    expect(boot.observe.mock.invocationCallOrder[0]).toBeLessThan(deps.spawnAsync.mock.invocationCallOrder[0]!);
    expect(boot.dispose).toHaveBeenCalled();
  });

  it.each([
    ['o spawn com resume é recusado (conversa não encontrada)', { requestId: 'r', ok: false, error: 'resume_context_unavailable: conversa original indisponível' }, 'proved'],
    ['o resume sobe e cai no boot', { requestId: 'r', ok: true, paneId: 'resumed-pane', sessionId: 'resumed-session' }, 'failed'],
  ] as const)('fallback quando %s: sessão nova + pacote, e o pane sobe', async (_label, first, verdict) => {
    const boot = fakeBoot(verdict);
    deps.spawnAsync
      .mockResolvedValueOnce(first as OrchPaneSpawnResult)
      .mockResolvedValueOnce({ requestId: 'r2', ok: true, paneId: 'pack-pane', sessionId: 'pack-session' });
    await expect(respawnMainOwnedPaneWithAccount({ ...switchInput, nativeResume: true },
      { rebindSession: vi.fn(() => true), observeResumeBoot: boot.observe })).resolves.toBe(true);
    expect(deps.spawnAsync).toHaveBeenCalledTimes(2);
    const fallback = deps.spawnAsync.mock.calls[1]![0] as { initialPrompt: string; resume?: boolean; resumeFromPaneId?: string; accountId?: string };
    expect(fallback.accountId).toBe('acct-b');
    expect(fallback).not.toHaveProperty('resumeFromPaneId');
    expect(fallback.initialPrompt).toContain('NEW provider session');
    expect(fallback.initialPrompt).toContain('Continuar F-1473');
    expect(detectLimit(fallback.initialPrompt)).toBeNull();
  });

  it('conversa que não pôde ser religada (ou adapter sem histórico compartilhado): só o pacote, como antes', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    const boot = fakeBoot('proved');
    await expect(respawnMainOwnedPaneWithAccount({ ...switchInput, nativeResume: true },
      { rebindSession: vi.fn(() => false), observeResumeBoot: boot.observe })).resolves.toBe(true);
    expect(deps.spawnAsync).toHaveBeenCalledTimes(1);
    const options = deps.spawnAsync.mock.calls[0]![0] as { initialPrompt: string };
    expect(options).not.toHaveProperty('resumeFromPaneId');
    expect(options.initialPrompt).toContain('NEW provider session');
    expect(boot.observe).not.toHaveBeenCalled();
  });

  it('encerrado pelo próprio Nexus na janela (missão cancelada, pane fechado): não é queda — sem fallback', async () => {
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'resumed-pane', sessionId: 'resumed-session' });
    await expect(respawnMainOwnedPaneWithAccount({ ...switchInput, nativeResume: true },
      { rebindSession: vi.fn(() => true), observeResumeBoot: fakeBoot('closed').observe })).resolves.toBe(true);
    expect(deps.spawnAsync).toHaveBeenCalledTimes(1);
    expect(deps.deletePane).not.toHaveBeenCalled();
  });

  it('substituto vivo sem prova (não retomou): é encerrado antes do pacote — nunca dois workers', async () => {
    pty.sessions.set('resumed-session', { paneId: 'resumed-pane', spawnedAt: Date.now(), resumed: false });
    deps.terminate.mockImplementation(async (...args: unknown[]) => { pty.sessions.delete(String(args[0])); return true; });
    deps.spawnAsync
      .mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'resumed-pane', sessionId: 'resumed-session' })
      .mockResolvedValueOnce({ requestId: 'r2', ok: true, paneId: 'pack-pane', sessionId: 'pack-session' });
    try {
      await expect(respawnMainOwnedPaneWithAccount({ ...switchInput, nativeResume: true },
        { rebindSession: vi.fn(() => true), observeResumeBoot: fakeBoot('failed').observe })).resolves.toBe(true);
      expect(deps.terminate).toHaveBeenCalledWith('resumed-session', expect.objectContaining({ origin: 'failover-respawn' }));
      const resumedEnd = deps.terminate.mock.calls.findIndex((call) => (call as unknown[])[0] === 'resumed-session');
      expect(deps.terminate.mock.invocationCallOrder[resumedEnd]).toBeLessThan(deps.spawnAsync.mock.invocationCallOrder[1]!);
      // Sem pane morto: o substituto sai do inventário antes do pacote.
      expect(deps.deletePane).toHaveBeenCalledWith('resumed-pane');
      expect(deps.deletePane.mock.invocationCallOrder[0]).toBeLessThan(deps.spawnAsync.mock.invocationCallOrder[1]!);
      expect(deps.spawnAsync).toHaveBeenCalledTimes(2);
    } finally {
      pty.sessions.clear();
      deps.terminate.mockReset().mockResolvedValue(true);
    }
  });
});

/** Observador falso da prova de boot (a lógica real tem a suíte própria abaixo). */
function fakeBoot(verdict: ResumeBootVerdict) {
  const confirm = vi.fn(async (_target: { paneId?: string; sessionId?: string }): Promise<ResumeBootVerdict> => verdict);
  const dispose = vi.fn();
  const observe = vi.fn((): ResumeBootObserver => ({ confirm, dispose }));
  return { observe, confirm, dispose };
}

describe('F-1482: o pedido em voo do worker atravessa a troca de conta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.spawnAsync.mockReset();
    deps.terminate.mockResolvedValue(true);
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta });
  });
  afterEach(() => resetInFlightRequestsForTests());

  it('sessão nova: o pack reentrega o último pedido do Maestro e o pane novo o herda', async () => {
    noteInFlightRequest('old-pane', 'Implementar o motor');
    noteInFlightRequest('old-pane', 'Ajuste do Maestro: usar a fila nova');
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', toAccountId: 'acct-b',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined,
    })).resolves.toBe(true);
    const options = deps.spawnAsync.mock.calls[0]![0] as { initialPrompt: string };
    expect(options.initialPrompt).toContain('Request in flight (last delivered to this pane; finish it if it is not done)');
    expect(options.initialPrompt).toContain('Ajuste do Maestro: usar a fila nova');
    expect(detectLimit(options.initialPrompt)).toBeNull();
    // Troca em cadeia: a próxima troca deste pane novo ainda sabe o pedido.
    expect(inFlightRequestOf('new-pane')).toBe(inFlightRequestOf('old-pane'));
  });

  it('retomada nativa: a nota curta leva o pedido em voo', async () => {
    noteInFlightRequest('old-pane', 'Ajuste do Maestro: usar a fila nova');
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' },
      meta: { ...meta, scope: { installationId: 'i', projectId: 'p' } } });
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude', toAccountId: 'acct-b', fromAccountId: 'acct-a',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined, nativeResume: true,
    }, { rebindSession: vi.fn(() => true), observeResumeBoot: fakeBoot('proved').observe, deliverBrief: vi.fn(async () => true) })).resolves.toBe(true);
    const options = deps.spawnAsync.mock.calls[0]![0] as { initialPrompt: string; resumeFromPaneId?: string };
    expect(options.resumeFromPaneId).toBe('old-pane');
    expect(options.initialPrompt).toContain('Request in flight: Ajuste do Maestro: usar a fila nova');
    expect(inFlightRequestOf('new-pane')).toBe('Ajuste do Maestro: usar a fila nova');
  });

  /** F-1512: o Maestro escreve na origem viva enquanto o pane novo sobe. */
  function spawnAcceptingOriginWrite(write: string) {
    deps.spawnAsync.mockImplementationOnce(async () => {
      noteInFlightRequest('old-pane', write);
      return { requestId: 'r', ok: true, paneId: 'new-pane', sessionId: 'new-session' };
    });
  }

  it('F-1512: pedido aceito na origem durante o boot chega ao substituto, uma vez, antes de a origem sair', async () => {
    noteInFlightRequest('old-pane', 'Implementar o motor');
    spawnAcceptingOriginWrite('Ajuste do Maestro durante a troca: usar a fila nova');
    const deliverBrief = vi.fn(async () => true);
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', toAccountId: 'acct-b',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief })).resolves.toBe(true);
    // Codex leva o pacote no argv: a única colagem é o delta.
    expect(deliverBrief).toHaveBeenCalledTimes(1);
    const [sessionId, prompt, adapterId] = deliverBrief.mock.calls[0] as unknown as [string, string, string];
    expect([sessionId, adapterId]).toEqual(['new-session', 'codex']);
    expect(prompt).toContain('Ajuste do Maestro durante a troca: usar a fila nova');
    // O que o pacote já levou não é repetido.
    expect(prompt).not.toContain('Implementar o motor');
    expect((deps.spawnAsync.mock.calls[0]![0] as { initialPrompt: string }).initialPrompt).toContain('Implementar o motor');
    // Só depois a origem é aposentada.
    expect(deliverBrief.mock.invocationCallOrder[0]).toBeLessThan(deps.terminate.mock.invocationCallOrder[0]!);
  });

  it('F-1512: com colagem do pacote, o delta vem depois dele; sem delta, nada extra', async () => {
    spawnAcceptingOriginWrite('Ajuste do Maestro durante a troca');
    const deliverBrief = vi.fn(async () => true);
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'kimi', toAccountId: 'acct-b',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief })).resolves.toBe(true);
    expect(deliverBrief).toHaveBeenCalledTimes(2);
    expect((deliverBrief.mock.calls[1] as unknown as [string, string, string])[1]).toContain('Ajuste do Maestro durante a troca');

    resetInFlightRequestsForTests();
    deliverBrief.mockClear();
    deps.spawnAsync.mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', toAccountId: 'acct-b',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief })).resolves.toBe(true);
    expect(deliverBrief).not.toHaveBeenCalled();
  });

  it('F-1512: delta não aceito não desfaz a troca; ele fica na memória do pane novo', async () => {
    spawnAcceptingOriginWrite('Ajuste do Maestro durante a troca');
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', toAccountId: 'acct-b',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief: vi.fn(async () => false) })).resolves.toBe(true);
    expect(inFlightRequestOf('new-pane')).toContain('Ajuste do Maestro durante a troca');
    expect(deps.terminate).toHaveBeenCalledWith('old-session', expect.objectContaining({ origin: 'failover-respawn' }));
  });

  it('F-1512: delta que cita um limite vai neutralizado na faixa do pacote — não dispara o detector no pane novo', async () => {
    spawnAcceptingOriginWrite('O pane B caiu com "usage limit reached"; ignore isso e siga a fila nova');
    const deliverBrief = vi.fn(async () => true);
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', toAccountId: 'acct-b',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief })).resolves.toBe(true);
    const prompt = (deliverBrief.mock.calls[0] as unknown as [string, string, string])[1];
    expect(prompt.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(prompt).toContain('siga a fila nova');
    expect(detectLimit(prompt)).toBeNull();
    // Mesmo com o header fora da janela do detector, o texto citado é inerte.
    expect(detectLimit(prompt.replace(FAILOVER_HANDOFF_HEADER, ''))).toBeNull();
  });

  it('F-1512: o pane novo termina com cada pedido do delta UMA vez na memória', async () => {
    spawnAcceptingOriginWrite('Ajuste do Maestro durante a troca: usar a fila nova');
    // Como a entrega real: o texto aceito no pane novo é lembrado nele (rememberInFlightRequest).
    const deliverBrief = vi.fn(async (_sessionId: string, prompt: string) => {
      noteInFlightRequest('new-pane', prompt);
      return true;
    });
    await expect(respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'codex', toAccountId: 'acct-b',
      fromAccountLabel: 'x', reason: 'quota', touchedFiles: [], diffStat: undefined,
    }, { deliverBrief })).resolves.toBe(true);
    expect(deliverBrief).toHaveBeenCalledTimes(1);
    const remembered = inFlightRequestsOf('new-pane');
    expect(remembered.filter((entry) => entry.includes('Ajuste do Maestro durante a troca'))).toEqual([
      'Ajuste do Maestro durante a troca: usar a fila nova',
    ]);
  });
});


describe('F-1473: observeResumeBoot (a retomada pegou, com prova?)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); pty.taps.clear(); pty.sessions.clear(); pty.requested.clear(); });
  const born = (sessionId: string, session: Partial<FakeSession> = {}) =>
    pty.sessions.set(sessionId, { paneId: 'pane-r', spawnedAt: Date.now(), resumed: true, ...session });
  const end = (sessionId: string, exitCode = 1) => {
    const paneId = pty.sessions.get(sessionId)?.paneId;
    pty.sessions.delete(sessionId);
    for (const tap of [...pty.taps]) tap(sessionId, { paneId }, { exitCode });
  };

  it('sessão vinculada, retomada exata e viva 10 s depois do NASCIMENTO físico = prova', async () => {
    const boot = observeResumeBoot({ windowMs: 10_000 });
    born('s-1');
    await vi.advanceTimersByTimeAsync(8_000);
    let verdict: ResumeBootVerdict | undefined;
    void boot.confirm({ paneId: 'pane-r' }).then((value) => { verdict = value; });
    // Contado do nascimento (8 s atrás), não de agora: faltam só 2 s.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(verdict).toBe('proved');
    boot.dispose();
  });

  it('CLI que nasce aos 15 s e cai aos 16 s: sem prova (a janela começa no nascimento)', async () => {
    const boot = observeResumeBoot({ windowMs: 10_000 });
    const verdict = boot.confirm({ paneId: 'pane-r' });
    await vi.advanceTimersByTimeAsync(15_000);
    born('s-late');
    await vi.advanceTimersByTimeAsync(1_000);
    end('s-late');
    await expect(verdict).resolves.toBe('failed');
    boot.dispose();
  });

  it('saída antes de o observador ser consultado (antes do confirm) conta como queda', async () => {
    const boot = observeResumeBoot({ windowMs: 10_000 });
    born('s-early');
    end('s-early');
    await expect(boot.confirm({ paneId: 'pane-r' })).resolves.toBe('failed');
    boot.dispose();
  });

  it('spawn que não retomou (resume não exato) não é prova', async () => {
    const boot = observeResumeBoot({ windowMs: 10_000 });
    born('s-fresh', { resumed: false });
    await expect(boot.confirm({ paneId: 'pane-r' })).resolves.toBe('failed');
    boot.dispose();
  });

  it('nenhuma sessão até o prazo de vínculo: sem prova', async () => {
    const boot = observeResumeBoot({ windowMs: 10_000, bindTimeoutMs: 75_000 });
    const verdict = boot.confirm({ paneId: 'pane-r' });
    await vi.advanceTimersByTimeAsync(75_000);
    await expect(verdict).resolves.toBe('failed');
    boot.dispose();
  });

  it('pela sessão dada: o fim de outra sessão não conta; qualquer fim dela antes da janela, sim', async () => {
    const boot = observeResumeBoot({ windowMs: 10_000 });
    born('s-2');
    born('outra', { paneId: 'pane-x' });
    const verdict = boot.confirm({ sessionId: 's-2' });
    end('outra');
    await vi.advanceTimersByTimeAsync(3_000);
    end('s-2', 0);
    await expect(verdict).resolves.toBe('failed');
    boot.dispose();
    expect(pty.taps.size).toBe(0);
  });

  it('fim pedido pelo próprio Nexus na janela (antes ou depois do confirm) = closed, não queda', async () => {
    const boot = observeResumeBoot({ windowMs: 10_000 });
    born('s-close');
    const verdict = boot.confirm({ paneId: 'pane-r' });
    await vi.advanceTimersByTimeAsync(2_000);
    pty.requested.add('s-close');
    end('s-close');
    await expect(verdict).resolves.toBe('closed');
    born('s-close-early', { paneId: 'pane-q' });
    pty.requested.add('s-close-early');
    end('s-close-early');
    await expect(boot.confirm({ paneId: 'pane-q' })).resolves.toBe('closed');
    boot.dispose();
  });
});

describe('F-822: estado da tarefa só da worktree do pane, git seguro e curto', () => {
  it('checkout compartilhado não entra: nenhum git roda e o pacote fica sem a seção', async () => {
    const shared = tempDir('nexus-f822-shared-');
    const git = fakeGit();
    await expect(collectGitTaskState(shared, { sharedRootPath: shared, git: git.runner }))
      .resolves.toEqual({ touchedFiles: [], diffStat: undefined });
    await expect(collectGitTaskState(undefined, { git: git.runner }))
      .resolves.toEqual({ touchedFiles: [], diffStat: undefined });
    expect(git.calls).toEqual([]);
  });

  it('worktree própria: confere a config local antes, diff sem driver externo, timeout de 1 s em tudo', async () => {
    const worktree = tempDir('nexus-f822-worktree-');
    const shared = tempDir('nexus-f822-shared-');
    const git = fakeGit();
    const state = await collectGitTaskState(worktree, { sharedRootPath: shared, git: git.runner });
    expect(state).toEqual({ touchedFiles: ['src/a.ts', 'src/novo.ts'], diffStat: 'src/a.ts | 3 ++-' });
    expect(git.calls[0]!.args.slice(0, 3)).toEqual(['config', '--local', '--get-regexp']);
    expect(git.calls.map((call) => call.args[0])).toEqual(['config', 'status', 'diff']);
    expect(git.calls[2]!.args).toEqual(['diff', '--stat', '--no-ext-diff', '--no-textconv']);
    expect(GIT_STATE_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
    expect(git.calls.every((call) => call.timeoutMs === GIT_STATE_TIMEOUT_MS)).toBe(true);
  });

  it('config local executável plantada (fsmonitor/textconv): recusa sem rodar status nem diff', async () => {
    const worktree = tempDir('nexus-f822-worktree-');
    const git = fakeGit({
      config: { status: 0, stdout: 'core.fsmonitor /tmp/planted.sh\n', stderr: '' },
    });
    await expect(collectGitTaskState(worktree, { git: git.runner }))
      .resolves.toEqual({ touchedFiles: [], diffStat: undefined });
    expect(git.calls.map((call) => call.args[0])).toEqual(['config']);
  });

  it('git lento ou quebrado não segura o failover: a seção some', async () => {
    const worktree = tempDir('nexus-f822-worktree-');
    const git = fakeGit({ status: new Error('Git process could not complete (timeout)') });
    await expect(collectGitTaskState(worktree, { git: git.runner }))
      .resolves.toEqual({ touchedFiles: [], diffStat: undefined });
  });

  it('o planejador é puro: com o estado já coletado, não roda git nenhum', () => {
    const plan = planMainOwnedFailoverRespawn({
      adapterId: 'claude', meta: { ...meta, executionScope: { rootRealPath: '/inexistente' } } as never,
      toAccountId: 'acct-2', fromAccountLabel: 'a@b.c', reason: 'quota',
      touchedFiles: ['x.ts'], diffStat: 'x.ts | 1 +',
    });
    expect(plan.action).toBe('respawn');
    expect(deps.execFileSync).not.toHaveBeenCalled();
    expect(deps.spawnSyncChild).not.toHaveBeenCalled();
  });
});

/**
 * F-1476 (revisão Codex): o pty-manager põe o pacote no argv do orquestrador
 * só no canal posicional, e nunca numa retomada. O respawn Main-owned de um
 * Maestro Qwen/MiMo/AGY (flag interativa) ou Kimi (colagem) nascia mudo, e a
 * nota da retomada do F-1473 nunca chegava. Agora cola com prova de aceite
 * depois da prova de boot e antes de confirmar a recuperação.
 */
describe('F-1476: failover Main-owned entrega o pacote a quem não o recebe no argv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.spawnAsync.mockReset();
    deps.terminate.mockReset().mockResolvedValue(true);
    deps.spawnAsync.mockResolvedValue({ requestId: 'r', ok: true, paneId: 'new-pane', sessionId: 'new-session' });
  });
  afterEach(() => pty.sessions.clear());
  const respawn = (
    adapterId: string,
    role: 'orchestrator' | 'worker',
    deliverBrief: (...args: [string, string, string]) => Promise<boolean>,
  ) => {
    deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta: { ...meta, role } });
    return respawnMainOwnedPaneWithAccount({
      paneId: 'old-pane', sessionId: 'old-session', adapterId, toModel: 'fixture-model',
      fromAccountLabel: 'fixture', reason: 'model rejected',
    }, { deliverBrief });
  };

  it.each(['qwen', 'mimo-code', 'agy', 'kimi'])('Maestro %s recebe o pacote por colagem com prova antes do sucesso', async (adapterId) => {
    const deliverBrief = vi.fn(async () => true);
    expect(await respawn(adapterId, 'orchestrator', deliverBrief)).toBe(true);
    expect(deliverBrief).toHaveBeenCalledTimes(1);
    expect(deliverBrief).toHaveBeenCalledWith('new-session', expect.stringContaining('religado automaticamente'), adapterId);
    // Orquestrador: a sessão exausta sai antes (um Maestro por missão, F-1480).
    expect(deps.terminate.mock.invocationCallOrder[0]).toBeLessThan(deliverBrief.mock.invocationCallOrder[0]!);
  });

  it('colagem não aceita: o pane novo sai (sem pane morto) e a recuperação não é confirmada', async () => {
    pty.sessions.set('new-session', { paneId: 'new-pane', spawnedAt: Date.now(), resumed: false });
    deps.terminate.mockImplementation(async (...args: unknown[]) => { pty.sessions.delete(String(args[0])); return true; });
    const deliverBrief = vi.fn(async () => false);
    expect(await respawn('qwen', 'orchestrator', deliverBrief)).toBe(false);
    expect(deps.terminate).toHaveBeenCalledWith('new-session', expect.objectContaining({ origin: 'failover-respawn' }));
    expect(deps.deletePane).toHaveBeenCalledWith('new-pane');
  });

  it('worker com colagem que lança: o pane novo sai e a tarefa segue no pane de antes', async () => {
    const deliverBrief = vi.fn(async () => { throw new Error('pty fechado'); });
    expect(await respawn('kimi', 'worker', deliverBrief)).toBe(false);
    // F-1480: o worker nasce antes; sem aceite, a sessão exausta nem é tocada.
    expect(deps.terminate).not.toHaveBeenCalledWith('old-session', expect.anything());
    expect(deps.deletePane).toHaveBeenCalledWith('new-pane');
  });

  it('worker Kimi (canal de colagem) também recebe o pacote colado', async () => {
    const deliverBrief = vi.fn(async () => true);
    expect(await respawn('kimi', 'worker', deliverBrief)).toBe(true);
    expect(deliverBrief).toHaveBeenCalledWith('new-session', expect.any(String), 'kimi');
  });

  it.each([
    ['qwen', 'worker'],
    ['agy', 'worker'],
    ['claude', 'orchestrator'],
    ['codex', 'worker'],
  ] as const)('%s como %s recebe o pacote no argv: nada a colar', async (adapterId, role) => {
    const deliverBrief = vi.fn(async () => true);
    expect(await respawn(adapterId, role, deliverBrief)).toBe(true);
    expect(deliverBrief).not.toHaveBeenCalled();
  });

  describe('retomada nativa do F-1473', () => {
    const scopedMeta = {
      ...meta,
      scope: { version: 1 as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/project', identitySource: 'manifest' as const },
    };
    const resumeInput = {
      paneId: 'old-pane', sessionId: 'old-session', adapterId: 'claude', toAccountId: 'acct-b', fromAccountId: 'acct-a',
      toAccountLabel: 'ana.ops@example.org', fromAccountLabel: 'x', reason: 'quota', touchedFiles: [] as string[],
      diffStat: undefined, nativeResume: true,
    };
    beforeEach(() => {
      deps.getPane.mockReturnValue({ entry: { paneId: 'old-pane', sessionId: 'old-session' }, meta: scopedMeta });
    });

    it('retomada com prova de boot: a nota é colada DEPOIS da prova, mesmo no Claude posicional', async () => {
      const boot = fakeBoot('proved');
      const deliverBrief = vi.fn(async () => true);
      await expect(respawnMainOwnedPaneWithAccount(resumeInput,
        { rebindSession: vi.fn(() => true), observeResumeBoot: boot.observe, deliverBrief })).resolves.toBe(true);
      expect(deliverBrief).toHaveBeenCalledWith('new-session', expect.stringContaining('resumed THIS SAME conversation'), 'claude');
      // Uma vez só: o pty-manager não entrega prompt numa retomada (nada em dobro).
      expect(deliverBrief).toHaveBeenCalledTimes(1);
      expect(boot.confirm.mock.invocationCallOrder[0]).toBeLessThan(deliverBrief.mock.invocationCallOrder[0]!);
    });

    it('retomada encerrada pelo próprio Nexus na janela (closed): nada é colado', async () => {
      const deliverBrief = vi.fn(async () => true);
      await expect(respawnMainOwnedPaneWithAccount(resumeInput,
        { rebindSession: vi.fn(() => true), observeResumeBoot: fakeBoot('closed').observe, deliverBrief })).resolves.toBe(true);
      expect(deliverBrief).not.toHaveBeenCalled();
    });

    it('retomada sem prova cai no pacote em sessão nova do Claude: argv, nada a colar', async () => {
      deps.spawnAsync
        .mockResolvedValueOnce({ requestId: 'r', ok: true, paneId: 'resumed-pane', sessionId: 'resumed-session' })
        .mockResolvedValueOnce({ requestId: 'r2', ok: true, paneId: 'pack-pane', sessionId: 'pack-session' });
      const deliverBrief = vi.fn(async () => true);
      await expect(respawnMainOwnedPaneWithAccount(resumeInput,
        { rebindSession: vi.fn(() => true), observeResumeBoot: fakeBoot('failed').observe, deliverBrief })).resolves.toBe(true);
      expect(deliverBrief).not.toHaveBeenCalled();
    });
  });
});

it('F-1476: respawnBriefNeedsPaste — retomada sempre cola (uma vez); sem retomada vale a regra do canal', () => {
  expect(respawnBriefNeedsPaste('claude', 'orchestrator', true)).toBe(true);
  expect(respawnBriefNeedsPaste('claude', 'orchestrator', false)).toBe(false);
  expect(respawnBriefNeedsPaste('qwen', 'orchestrator', true)).toBe(true);
  expect(respawnBriefNeedsPaste('qwen', 'orchestrator')).toBe(true);
  expect(respawnBriefNeedsPaste('qwen', 'worker')).toBe(false);
  expect(respawnBriefNeedsPaste('kimi', 'worker')).toBe(true);
  expect(respawnBriefNeedsPaste('cli-desconhecida', 'orchestrator', true)).toBe(false);
});

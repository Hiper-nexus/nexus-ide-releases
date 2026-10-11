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
  /** F-822: nada de processo síncrono no caminho do failover. */
  execFileSync: vi.fn(() => { throw new Error('execFileSync no caminho do failover'); }),
  spawnSyncChild: vi.fn(() => { throw new Error('spawnSync no caminho do failover'); }),
}));
const advisor = vi.hoisted(() => ({ scheduleRecoveryAdvice: vi.fn() }));
vi.mock('./jev-mission-advisor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-mission-advisor')>()),
  scheduleRecoveryAdvice: advisor.scheduleRecoveryAdvice,
}));
vi.mock('./main-owned-pane-runtime', () => ({ getMainOwnedPane: deps.getPane }));
vi.mock('./pane-registry', () => ({
  spawnMainOwnedMissionPane: deps.spawnSync,
  spawnMainOwnedMissionPaneAsync: deps.spawnAsync,
}));
vi.mock('../pty/pty-manager', () => ({ orchTerminateSession: deps.terminate }));
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
  respawnMainOwnedPaneWithAccount,
} from './failover-mission-respawn';
import {
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
} from '../../shared/failover-handoff';
import { maskAccountLabel } from '../../shared/account-choice';
import { detectLimit } from './limit-detector';
import { createVisualTaskRequirement, visualTaskAtSpawn } from './visual-handoff-gate';
import { CONTEXT_HANDOFF_BUDGET_ERROR } from './context-handoff-budget';
import { forgetPaneTaskReroute, registerPaneTaskReroute } from './pane-task-reroute';
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

  it.each(['unproved', 'rejected'])('F-890 keeps the worker without replacement when termination is %s', async (mode) => {
    deps.spawnAsync.mockResolvedValue({ requestId: 'unexpected', ok: true, paneId: 'unexpected', sessionId: 'unexpected' });
    if (mode === 'unproved') deps.terminate.mockResolvedValueOnce(false);
    else deps.terminate.mockRejectedValueOnce(new Error('fixture physical proof unavailable'));
    const result = await respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toModel: 'fixture-model', fromAccountLabel: 'fixture', reason: 'model rejected' });
    expect(result).toBe(false);
    expect(deps.spawnAsync).not.toHaveBeenCalled();
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
    deps.spawnAsync.mockResolvedValue({ requestId: 'unexpected', ok: true, paneId: 'unexpected', sessionId: 'unexpected' });
    deps.terminate.mockImplementationOnce(async () => { deps.getPane.mockReturnValue(undefined); return true; });
    const flight = respawnMainOwnedPaneWithAccount({ paneId: 'old-pane', sessionId: 'old-session',
      adapterId: 'claude', toModel: 'fixture-model', fromAccountLabel: 'fixture', reason: 'model rejected' });
    expect(await flight).toBe(false);
    expect(deps.spawnAsync).not.toHaveBeenCalled();
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
    // Termina a sessão exausta ANTES do spawn novo.
    expect(deps.terminate).toHaveBeenCalledWith(
      'old-session',
      expect.objectContaining({ origin: 'failover-respawn' }),
    );
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

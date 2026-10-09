import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from '../jarvis/audit-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { assertCompletionEffectsSettled } from './automatic-completion-proof';
import { createScopedCommandReceiptStore } from './command-receipts';
import { createScopedEffectOutboxStore } from './effect-outbox';
import {
  drainEffectOutbox,
  registerCheckpointCaptureHandler,
  registerEffectOutboxHandler,
  registeredEffectHandler,
} from './effect-outbox-worker';
import { mintToken, resetGateForTests, type AgentGateContext } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { handleMcpMessage } from './mcp-protocol';
import { reconcileProviderRuntimeAtBoot } from './provider-runtime-recovery';
import type { McpRegistry } from './mcp-protocol';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
} from './project-domain-store-registry';
import { testProjectScope } from './__tests__/scope-fixture';

const MISSION_ID = 'mission-command-effect';

describe('dispatchToolCall accepts the checkpoint effect', () => {
  const directories: string[] = [];
  const managers: ProjectRuntimeManager[] = [];
  let configured = false;

  afterEach(async () => {
    resetGateForTests();
    if (configured) {
      configured = false;
      await disposeProjectDomainStoreRegistry();
      await disposeAuditLogRuntime();
    }
    for (const manager of managers.splice(0)) manager.closeAll();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records a checkpoint the completion gate sees, then the production handler settles it', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-command-effect-'));
    directories.push(baseDir);
    const manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: 'command-effect-test',
    });
    managers.push(manager);
    const scope = testProjectScope({
      projectId: 'project-command-effect',
      checkoutId: 'checkout-command-effect',
      rootRealPath: baseDir,
    });
    configureAuditLogRuntime(manager);
    configureProjectDomainStoreRegistry(manager);
    configured = true;
    const now = Date.now();
    manager.open(scope).db.prepare(
      `INSERT INTO missions
         (id, title, description, status, milestones_json, created_at, updated_at)
       VALUES (?, ?, '', 'running', '[]', ?, ?)`,
    ).run(MISSION_ID, 'Command effect', now, now);

    let sawPending = false;
    const handler = async () => {
      expect(() =>
        assertCompletionEffectsSettled(manager, scope, MISSION_ID),
      ).toThrow(/completion_effects_pending/);
      sawPending = true;
      return { ok: true };
    };
    const registry: McpRegistry = {
      tools: [
        {
          name: 'nexus_terminal_run',
          description: 'command effect proof',
          inputSchema: { type: 'object', properties: {} },
          handler,
        },
      ],
      serverName: 'command-effect-test',
      serverVersion: '0',
    };
    resetGateForTests();
    const ctx = mintToken({
      label: 'command-effect',
      role: 'worker',
      missionId: MISSION_ID,
      scope,
      allowedTools: null,
      allowedSkills: null,
    });
    const result = await dispatchToolCall(
      'http-mcp',
      registry,
      'nexus_terminal_run',
      { command: 'true' },
      ctx,
      {
        confirm: async () => false,
        reserveMissionBudget: () => undefined,
        resolveWorkflowAuthority: () => ({
          contextRevision: undefined,
          assertExecutionEffectAllowed() {
            return undefined;
          },
        }),
        resolveMissionForIntentGate: (_scope, missionId) =>
          missionId === MISSION_ID
            ? {
                mission: {
                  id: MISSION_ID,
                  title: 'Command effect',
                  description: 'production path',
                  status: 'running',
                  milestones: [],
                  learnings: '',
                  intentState: 'dispatched',
                  intentVersion: 1,
                  intentContract: {
                    version: 1,
                    source: 'typed',
                    goal: 'prove the receipt',
                    acceptanceCriteria: ['ok'],
                    risk: 'normal',
                    executionMode: 'assisted',
                    contextPolicy: 'on-demand',
                    intentVersion: 1,
                    approvedAt: Date.now(),
                    budgets: {
                      planningTokens: 100,
                      executionTokens: 100,
                      maxWorkers: 1,
                    },
                  },
                  createdAt: 1,
                  updatedAt: 1,
                },
                taskCount: 0,
                workerPaneCount: 0,
              }
            : null,
      },
    );

    expect(result).toMatchObject({ ok: true, tool: 'nexus_terminal_run' });
    expect(sawPending).toBe(true);
    const outbox = createScopedEffectOutboxStore(manager, scope);
    const blocking = outbox.listUnsettledBlocking(MISSION_ID);
    expect(blocking.truncated).toBe(false);
    expect(blocking.rows).toHaveLength(1);
    const effect = blocking.rows[0]!;
    expect(effect.type).toBe('checkpoint.capture');
    expect(effect.status).toBe('pending');
    const receipt = createScopedCommandReceiptStore(manager, scope).getByCommandId(
      effect.commandId,
    );
    expect(receipt?.commandType).toBe('checkpoint.capture');
    expect(receipt?.commandId).toBe(effect.commandId);

    const previous = registeredEffectHandler('checkpoint.capture');
    const unregister = registerCheckpointCaptureHandler();
    try {
      const drained = await drainEffectOutbox({
        store: outbox,
        scope,
        workerId: 'orchestration-coordinator',
      });
      expect(drained).toMatchObject({
        claimed: 1,
        succeeded: 1,
        failed: 0,
        retried: 0,
      });
      expect(outbox.get(effect.id)?.status).toBe('succeeded');
      expect(() =>
        assertCompletionEffectsSettled(manager, scope, MISSION_ID),
      ).not.toThrow();
    } finally {
      unregister();
      if (previous) registerEffectOutboxHandler('checkpoint.capture', previous);
    }
  });

  function bootDispatch(
    handler: (
      args: Record<string, unknown>,
      ctx: AgentGateContext,
    ) => Promise<unknown>,
  ) {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-command-effect-'));
    directories.push(baseDir);
    const manager = new ProjectRuntimeManager({
      baseDir,
      appVersion: 'command-effect-test',
    });
    managers.push(manager);
    const scope = testProjectScope({
      projectId: 'project-command-effect',
      checkoutId: 'checkout-command-effect',
      rootRealPath: baseDir,
    });
    configureAuditLogRuntime(manager);
    configureProjectDomainStoreRegistry(manager);
    configured = true;
    const now = Date.now();
    manager.open(scope).db.prepare(
      `INSERT INTO missions
         (id, title, description, status, milestones_json, created_at, updated_at)
       VALUES (?, ?, '', 'running', '[]', ?, ?)`,
    ).run(MISSION_ID, 'Command effect', now, now);
    const registry: McpRegistry = {
      tools: [
        {
          name: 'nexus_terminal_run',
          description: 'command effect proof',
          inputSchema: { type: 'object', properties: {} },
          handler,
        },
      ],
      serverName: 'command-effect-test',
      serverVersion: '0',
    };
    resetGateForTests();
    const ctx = mintToken({
      label: 'command-effect',
      role: 'worker',
      missionId: MISSION_ID,
      scope,
      allowedTools: null,
      allowedSkills: null,
    });
    const options = {
      confirm: async () => false,
      reserveMissionBudget: () => undefined,
      resolveWorkflowAuthority: () => ({
        contextRevision: undefined,
        assertExecutionEffectAllowed() {
          return undefined;
        },
      }),
      resolveMissionForIntentGate: (_scope: typeof scope, missionId: string) =>
        missionId === MISSION_ID
          ? {
              mission: {
                id: MISSION_ID,
                title: 'Command effect',
                description: 'production path',
                status: 'running' as const,
                milestones: [],
                learnings: '',
                intentState: 'dispatched' as const,
                intentVersion: 1,
                intentContract: {
                  version: 1 as const,
                  source: 'typed' as const,
                  goal: 'prove the receipt',
                  acceptanceCriteria: ['ok'],
                  risk: 'normal' as const,
                  executionMode: 'assisted' as const,
                  contextPolicy: 'on-demand' as const,
                  intentVersion: 1,
                  approvedAt: Date.now(),
                  budgets: {
                    planningTokens: 100,
                    executionTokens: 100,
                    maxWorkers: 1,
                  },
                },
                createdAt: 1,
                updatedAt: 1,
              },
              taskCount: 0,
              workerPaneCount: 0,
            }
          : null,
    };
    return { manager, scope, registry, ctx, options };
  }

  it('runs the handler once when two dispatches share a logical operation id', async () => {
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: 'once' };
    });
    const options = {
      ...booted.options,
      logicalOperationId: 'logical-op-1',
    };
    const first = await dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      options,
    );
    const second = await dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      options,
    );
    expect(runs).toBe(1);
    expect(first).toMatchObject({
      ok: true,
      tool: 'nexus_terminal_run',
      result: { marker: 'once' },
    });
    expect(second).toEqual(first);
    const effects = createScopedEffectOutboxStore(
      booted.manager,
      booted.scope,
    ).listUnsettledBlocking(MISSION_ID);
    expect(effects.rows).toHaveLength(1);
    expect(effects.rows[0]?.type).toBe('checkpoint.capture');
    expect(effects.rows[0]?.commandId).toBe('logical-op-1');
  });

  it('charges the mission once when two in-flight dispatches share a logical operation id', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    let charges = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      await hold;
      return { marker: 'once' };
    });
    const options = {
      ...booted.options,
      logicalOperationId: 'logical-op-race',
      reserveMissionBudget: () => {
        charges += 1;
      },
    };
    const first = dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      options,
    );
    const second = dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      options,
    );
    const started = Date.now();
    while (runs < 1) {
      if (Date.now() - started > 2000) {
        throw new Error('handler did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(charges).toBe(1);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(charges).toBe(1);
    expect(right).toEqual(left);
    expect(
      createScopedEffectOutboxStore(booted.manager, booted.scope)
        .listUnsettledBlocking(MISSION_ID).rows,
    ).toHaveLength(1);
  });

  it('runs a new call that only reuses JSON-RPC id 1, even with the same arguments', async () => {
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: runs };
    });
    const message = {
      jsonrpc: '2.0' as const,
      id: '1',
      method: 'tools/call',
      params: {
        name: 'nexus_terminal_run',
        arguments: { command: 'same' },
      },
    };
    const first = await handleMcpMessage(
      booted.registry,
      booted.ctx,
      message,
      booted.options,
    );
    expect(
      createScopedCommandReceiptStore(booted.manager, booted.scope).listUnsettled(),
    ).toHaveLength(1);
    const second = await handleMcpMessage(
      booted.registry,
      booted.ctx,
      message,
      booted.options,
    );
    expect(runs).toBe(2);
    expect(first?.error).toBeUndefined();
    expect(second?.error).toBeUndefined();
    expect(
      createScopedEffectOutboxStore(booted.manager, booted.scope)
        .listUnsettledBlocking(MISSION_ID).rows,
    ).toHaveLength(2);
  });

  it('returns the stored outcome when the caller resends the same operation id', async () => {
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: 'stored' };
    });
    const call = (rpcId: string) =>
      handleMcpMessage(
        booted.registry,
        booted.ctx,
        {
          jsonrpc: '2.0',
          id: rpcId,
          method: 'tools/call',
          params: {
            name: 'nexus_terminal_run',
            arguments: { command: 'same' },
            operationId: 'op-lost-response',
          },
        },
        booted.options,
      );
    const first = await call('1');
    expect(
      createScopedCommandReceiptStore(booted.manager, booted.scope).listUnsettled(),
    ).toHaveLength(1);
    const second = await call('1');
    expect(runs).toBe(1);
    expect(second).toEqual(first);
    expect(second?.error).toBeUndefined();
  });

  it('keeps the checkpoint blocking when the handler is still in flight across one drain', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const booted = bootDispatch(async () => {
      entered();
      await hold;
      return { marker: 'done' };
    });
    const previous = registeredEffectHandler('checkpoint.capture');
    const unregister = registerCheckpointCaptureHandler();
    const pending = dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      {
        ...booted.options,
        logicalOperationId: 'logical-op-inflight',
      },
    );
    try {
      await started;
      const drained = await drainEffectOutbox({
        store: createScopedEffectOutboxStore(booted.manager, booted.scope),
        scope: booted.scope,
        workerId: 'orchestration-coordinator',
      });
      expect(drained.succeeded).toBe(0);
      expect(() =>
        assertCompletionEffectsSettled(
          booted.manager,
          booted.scope,
          MISSION_ID,
        ),
      ).toThrow(/completion_effects_pending/);
      const blocking = createScopedEffectOutboxStore(
        booted.manager,
        booted.scope,
      ).listUnsettledBlocking(MISSION_ID);
      expect(blocking.rows.map((row) => row.status)).toEqual(['pending']);
    } finally {
      release();
      unregister();
      if (previous) registerEffectOutboxHandler('checkpoint.capture', previous);
    }
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('drops a settled checkpoint receipt from the boot-unsettled set', async () => {
    const booted = bootDispatch(async () => ({ ok: true }));
    const dispatched = await dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      booted.options,
    );
    expect(dispatched.ok).toBe(true);
    const receipts = createScopedCommandReceiptStore(booted.manager, booted.scope);
    const pending = receipts.listUnsettled();
    expect(pending).toHaveLength(1);
    const commandId = pending[0]!.commandId;
    expect(pending[0]!.resultSequence).toBe(0);
    const previous = registeredEffectHandler('checkpoint.capture');
    const unregister = registerCheckpointCaptureHandler();
    try {
      const drained = await drainEffectOutbox({
        store: createScopedEffectOutboxStore(booted.manager, booted.scope),
        scope: booted.scope,
        workerId: 'orchestration-coordinator',
      });
      expect(drained).toMatchObject({ succeeded: 1, failed: 0 });
    } finally {
      unregister();
      if (previous) registerEffectOutboxHandler('checkpoint.capture', previous);
    }
    const settled = receipts.getByCommandId(commandId);
    expect(settled?.resultSequence).toBeGreaterThan(0);
    expect(settled?.status).toBe('accepted');
    expect(receipts.listUnsettled()).toEqual([]);
    const boot = reconcileProviderRuntimeAtBoot({
      scope: booted.scope,
      runtimeManager: booted.manager,
    });
    expect(boot.unsettledReceipts).toBe(0);
  });
});

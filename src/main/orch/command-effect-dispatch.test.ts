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
import { mintToken, resetGateForTests } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
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

  function bootDispatch(handler: () => Promise<unknown>) {
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
    expect(second).toMatchObject({ok:false,error:'command_result_unavailable',effectMayHaveCommitted:true});
    expect(second).not.toHaveProperty('result');
    const effects = createScopedEffectOutboxStore(
      booted.manager,
      booted.scope,
    ).listByCommandId('logical-op-1');
    expect(effects).toHaveLength(1);
    expect(effects[0]?.type).toBe('checkpoint.capture');
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
});

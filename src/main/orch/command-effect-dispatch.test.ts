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
import { acceptDispatchCheckpointEffect, createScopedCommandReceiptStore } from './command-receipts';
import { SETTLED_EFFECT_RETENTION_MS, createScopedEffectOutboxStore } from './effect-outbox';
import { maintainEffectOutboxes } from './effect-outbox-maintenance';
import {
  drainEffectOutbox,
  registerCheckpointCaptureHandler,
  registerEffectOutboxHandler,
  registeredEffectHandler,
} from './effect-outbox-worker';
import { mintToken, resetGateForTests, type AgentGateContext } from './gate';
import { dispatchToolCall } from './mcp-dispatch';
import { dispatchPtyStreamMissionAction } from './pty-stream-dispatch';
import { PtyStreamMissionControl } from './pty-stream-mission-control';
import { handleMcpMessage } from './mcp-protocol';
import { reconcileProviderRuntimeAtBoot } from './provider-runtime-recovery';
import type { McpRegistry } from './mcp-protocol';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
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

  it('stores a preview outcome without the CDP url or its ticket', async () => {
    const ticket = 'bearer-secret-ticket';
    const cdpWebSocketUrl = `ws://127.0.0.1:9/cdp/pane-a?ticket=${ticket}`;
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return {
        id: 'preview-1',
        url: 'http://127.0.0.1:9/',
        port: 9,
        cdpWebSocketUrl,
        note: `debug ${cdpWebSocketUrl}`,
        nested: { ticket },
      };
    });
    const call = () =>
      dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'true' },
        booted.ctx,
        { ...booted.options, logicalOperationId: 'op-preview' },
      );
    const live = await call();
    expect(live).toMatchObject({
      ok: true,
      result: { id: 'preview-1', url: 'http://127.0.0.1:9/', cdpWebSocketUrl },
    });
    const stored = createScopedCommandReceiptStore(
      booted.manager,
      booted.scope,
    ).getByCommandId('op-preview');
    expect(stored?.outcomeJson ?? '').not.toContain('cdpWebSocketUrl');
    expect(stored?.outcomeJson ?? '').not.toContain(ticket);
    expect(stored?.outcomeJson ?? '').not.toContain('ticket=');
    const replay = await call();
    expect(runs).toBe(1);
    const replayJson = JSON.stringify(replay);
    expect(replayJson).not.toContain('cdpWebSocketUrl');
    expect(replayJson).not.toContain(ticket);
    expect(replay).toMatchObject({
      ok: true,
      result: { id: 'preview-1', url: 'http://127.0.0.1:9/', port: 9 },
    });
  });

  it('does not replay a bearer already stored on a preview receipt', async () => {
    const ticket = 'bearer-secret-ticket';
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: 'should-not-run' };
    });
    acceptDispatchCheckpointEffect(booted.manager, booted.scope, {
      commandId: 'op-poison',
      threadId: MISSION_ID,
      toolName: 'terminal_run',
      missionBound: true,
    });
    booted.manager.open(booted.scope).db.prepare(
      `UPDATE command_receipts SET outcome_json = ? WHERE command_id = ?`,
    ).run(
      JSON.stringify({
        ok: true,
        tool: 'nexus_terminal_run',
        result: {
          url: 'http://127.0.0.1:9/',
          cdpWebSocketUrl: `ws://127.0.0.1:9/cdp/pane-a?ticket=${ticket}`,
          ticket,
        },
      }),
      'op-poison',
    );
    const replay = await dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      { ...booted.options, logicalOperationId: 'op-poison' },
    );
    expect(runs).toBe(0);
    const replayJson = JSON.stringify(replay);
    expect(replayJson).not.toContain('cdpWebSocketUrl');
    expect(replayJson).not.toContain(ticket);
    expect(replay).toMatchObject({
      ok: true,
      result: { url: 'http://127.0.0.1:9/' },
    });
  });

  it('returns effectMayHaveCommitted when a fresh process finds a receipt without an outcome', async () => {
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: 'ran' };
    });
    acceptDispatchCheckpointEffect(booted.manager, booted.scope, {
      commandId: 'op-restart',
      threadId: MISSION_ID,
      toolName: 'terminal_run',
      missionBound: true,
    });
    const pending = dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      { ...booted.options, logicalOperationId: 'op-restart' },
    );
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(result).toMatchObject({
      ok: false,
      effectMayHaveCommitted: true,
    });
    expect(runs).toBe(0);

    const live = dispatchToolCall(
      'http-mcp',
      booted.registry,
      'nexus_terminal_run',
      { command: 'true' },
      booted.ctx,
      { ...booted.options, logicalOperationId: 'op-live' },
    );
    acceptDispatchCheckpointEffect(booted.manager, booted.scope, {
      commandId: 'op-live',
      threadId: MISSION_ID,
      toolName: 'terminal_run',
      missionBound: true,
    });
    const raced = await Promise.race([
      live,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(raced).toMatchObject({
      ok: false,
      effectMayHaveCommitted: true,
    });
    expect(runs).toBe(0);
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

  it('prunes a settled generated receipt and still replays a caller operation id', async () => {
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: runs };
    });
    const receipts = createScopedCommandReceiptStore(booted.manager, booted.scope);
    const outbox = createScopedEffectOutboxStore(booted.manager, booted.scope);
    const previous = registeredEffectHandler('checkpoint.capture');
    const unregister = registerCheckpointCaptureHandler();
    const drain = () =>
      drainEffectOutbox({
        store: outbox,
        scope: booted.scope,
        workerId: 'orchestration-coordinator',
      });
    try {
      const generated = await dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'true' },
        booted.ctx,
        booted.options,
      );
      expect(generated).toMatchObject({ ok: true, result: { marker: 1 } });
      const pending = receipts.listUnsettled();
      expect(pending).toHaveLength(1);
      const generatedId = pending[0]!.commandId;
      expect(generatedId).not.toBe('op-keep');
      await drain();
      expect(receipts.getByCommandId(generatedId)?.resultSequence).toBeGreaterThan(0);

      const kept = await dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'true' },
        booted.ctx,
        { ...booted.options, logicalOperationId: 'op-keep' },
      );
      expect(runs).toBe(2);
      expect(kept).toMatchObject({ ok: true, result: { marker: 2 } });
      await drain();
      expect(receipts.getByCommandId('op-keep')?.resultSequence).toBeGreaterThan(0);
      expect(outbox.pruneSettled(0)).toBeGreaterThan(0);

      expect(receipts.getByCommandId(generatedId)).toBeNull();
      expect(receipts.getByCommandId('op-keep')?.resultSequence).toBeGreaterThan(0);
      const replay = await dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'true' },
        booted.ctx,
        { ...booted.options, logicalOperationId: 'op-keep' },
      );
      expect(runs).toBe(2);
      expect(replay).toEqual(kept);
    } finally {
      unregister();
      if (previous) registerEffectOutboxHandler('checkpoint.capture', previous);
    }
  });

  it('runs call-1 from two panes and replays it only on the same live channel', async () => {
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: runs };
    });
    const request = {
      id: 'call-1',
      tool: 'nexus_terminal_run',
      args: { command: 'true' },
    };
    const outcomes = new Map<string, Awaited<ReturnType<typeof dispatchPtyStreamMissionAction>>>();
    const control = new PtyStreamMissionControl({
      invoke: async (sessionId, action, channelId) => {
        const result = await dispatchPtyStreamMissionAction({
          sessionId,
          channelId,
          request: action,
          registry: booted.registry,
          ctx: booted.ctx,
          options: booted.options,
        });
        outcomes.set(`${sessionId}\0${channelId}`, result);
        return result;
      },
      isAuthorized: () => true,
      isInjectableIdle: () => false,
      write: () => true,
    });
    const channelA = control.ensureChannel('pane-a');
    const channelB = control.ensureChannel('pane-b');
    expect(channelA).not.toBe(channelB);
    control.acceptObservedAction('pane-a', request);
    control.acceptObservedAction('pane-b', request);
    const started = Date.now();
    while (runs < 2) {
      if (Date.now() - started > 2000) {
        throw new Error(`expected both panes to run, saw ${runs}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const receipts = createScopedCommandReceiptStore(booted.manager, booted.scope);
    const storedIds = booted.manager
      .open(booted.scope)
      .db.prepare(`SELECT command_id FROM command_receipts`)
      .all() as Array<{ command_id: string }>;
    expect(storedIds.map((row) => row.command_id)).not.toContain('call-1');
    expect(storedIds).toHaveLength(2);

    const replay = await dispatchPtyStreamMissionAction({
      sessionId: 'pane-a',
      channelId: channelA,
      request,
      registry: booted.registry,
      ctx: booted.ctx,
      options: booted.options,
    });
    expect(runs).toBe(2);
    expect(replay).toEqual(outcomes.get(`pane-a\0${channelA}`));

    control.dropSession('pane-a');
    const restarted = control.ensureChannel('pane-a');
    expect(restarted).not.toBe(channelA);
    control.acceptObservedAction('pane-a', request);
    const restartedAt = Date.now();
    while (runs < 3) {
      if (Date.now() - restartedAt > 2000) {
        throw new Error(`expected the new channel to run, saw ${runs}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(receipts.getByCommandId('call-1')).toBeNull();
  });

  it('prunes settled effects from the production maintenance path', async () => {
    let runs = 0;
    const booted = bootDispatch(async () => {
      runs += 1;
      return { marker: runs };
    });
    getProjectDomainStores(booted.scope);
    const receipts = createScopedCommandReceiptStore(booted.manager, booted.scope);
    const previous = registeredEffectHandler('checkpoint.capture');
    const unregister = registerCheckpointCaptureHandler();
    try {
      await dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'true' },
        booted.ctx,
        booted.options,
      );
      await dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'true' },
        booted.ctx,
        { ...booted.options, logicalOperationId: 'op-keep' },
      );
      await maintainEffectOutboxes();
      expect(receipts.listUnsettled()).toEqual([]);
      expect(receipts.getByCommandId('op-keep')?.resultSequence).toBeGreaterThan(0);
      const generatedRow = booted.manager
        .open(booted.scope)
        .db.prepare(
          `SELECT command_id FROM command_receipts WHERE command_id <> ?`,
        )
        .get('op-keep') as { command_id: string } | undefined;
      expect(generatedRow?.command_id).toBeTruthy();
      const aged = Date.now() - SETTLED_EFFECT_RETENTION_MS - 1_000;
      booted.manager.open(booted.scope).db.prepare(
        `UPDATE effect_outbox SET completed_at = ? WHERE status = 'succeeded'`,
      ).run(aged);
      await dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'recent' },
        booted.ctx,
        booted.options,
      );
      await maintainEffectOutboxes();
      expect(receipts.getByCommandId(generatedRow!.command_id)).toBeNull();
      expect(receipts.getByCommandId('op-keep')?.resultSequence).toBeGreaterThan(0);
      const surviving = booted.manager
        .open(booted.scope)
        .db.prepare(
          `SELECT COUNT(*) AS n FROM effect_outbox WHERE status = 'succeeded'`,
        )
        .get() as { n: number };
      expect(surviving.n).toBe(1);
      const replay = await dispatchToolCall(
        'http-mcp',
        booted.registry,
        'nexus_terminal_run',
        { command: 'true' },
        booted.ctx,
        { ...booted.options, logicalOperationId: 'op-keep' },
      );
      expect(runs).toBe(3);
      expect(replay).toMatchObject({ ok: true, result: { marker: 2 } });
    } finally {
      unregister();
      if (previous) registerEffectOutboxHandler('checkpoint.capture', previous);
    }
  });
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_DRAFT_CHANNELS } from '../../shared/context-draft-types';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ensureContextScaffold } from './context-doctor';
import { inspectContextAttestations } from './context-attestation';
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
  getContextKnowledgeService,
} from './context-workflow-registry';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
}));

const host = vi.hoisted(() => ({
  workspace: null as { path: string } | null,
  scope: null as import('../../shared/types').ProjectExecutionScope | null,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
}));

vi.mock('../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => host.workspace,
}));

vi.mock('../persistence/project-identity', () => ({
  resolveProjectExecutionScope: () => host.scope,
}));

import { registerContextDraftIpc } from './context-draft-ipc';

type Handler = (event: unknown, input?: unknown) => Promise<unknown>;

function handlerFor(channel: string): Handler {
  const call = electron.handle.mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`no IPC handler registered for ${channel}`);
  return call[1] as Handler;
}

let baseDir = '';
let root = '';
const managers: ProjectRuntimeManager[] = [];

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fixture() {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-draft-ipc-')));
  fs.writeFileSync(path.join(root, 'README.md'), '# Product source\nBilling rules.\n', {
    mode: 0o600,
  });
  const scope = testProjectScope({ rootRealPath: root });
  host.scope = scope;
  host.workspace = { path: root };
  ensureContextScaffold(scope);
  const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'ipc-test' });
  managers.push(manager);
  configureContextWorkflowRegistry(manager, { appVersion: 'ipc-test' });
  return { scope };
}

function proposeDraft(scope = host.scope as NonNullable<typeof host.scope>) {
  return getContextKnowledgeService(scope).propose(
    {
      targetPath: '.context/docs/testing.md',
      content: '# Testing\nRun unit tests.\n',
      expectedTargetHash: null,
      sources: [
        {
          type: 'file',
          locator: 'README.md',
          sourceHash: hash('# Product source\nBilling rules.\n'),
        },
      ],
    },
    Object.freeze({
      id: 'author-agent',
      sessionId: 'author-session',
      provider: 'codex',
    }),
  );
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-draft-ipc-runtime-'));
  electron.handle.mockClear();
  registerContextDraftIpc();
});

afterEach(() => {
  disposeContextWorkflowRegistry();
  for (const manager of managers.splice(0)) manager.closeAll();
  host.workspace = null;
  fs.rmSync(baseDir, { recursive: true, force: true });
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('context draft IPC (human independent review)', () => {
  it('requires an open workspace on both channels', async () => {
    fixture();
    host.workspace = null;
    await expect(handlerFor(CONTEXT_DRAFT_CHANNELS.listProposed)(null)).rejects.toThrow(
      /no workspace is open/i,
    );
    await expect(
      handlerFor(CONTEXT_DRAFT_CHANNELS.approve)(null, { draftId: 'draft-x' }),
    ).rejects.toThrow(/no workspace is open/i);
  });

  it('lists only proposed drafts of the active scope with reviewable content', async () => {
    fixture();
    const draft = proposeDraft();

    const listed = (await handlerFor(CONTEXT_DRAFT_CHANNELS.listProposed)(null)) as Array<
      Record<string, unknown>
    >;

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: draft.id,
      targetPath: '.context/docs/testing.md',
      content: '# Testing\nRun unit tests.\n',
      authorProvider: 'codex',
    });
  });

  it('validates the approve input before touching authority', async () => {
    fixture();
    await expect(
      handlerFor(CONTEXT_DRAFT_CHANNELS.approve)(null, { draftId: 'bad id!' }),
    ).rejects.toThrow();
    await expect(
      handlerFor(CONTEXT_DRAFT_CHANNELS.approve)(null, { draftId: 'draft-missing' }),
    ).rejects.toThrow(/context draft not found/i);
  });

  it('approves as the human reviewer, applies and attests the target', async () => {
    const { scope } = fixture();
    const draft = proposeDraft();

    const result = (await handlerFor(CONTEXT_DRAFT_CHANNELS.approve)(null, {
      draftId: draft.id,
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      draftId: draft.id,
      targetPath: '.context/docs/testing.md',
      status: 'applied',
      reviewerProvider: 'human',
      readinessReady: false,
    });
    expect(fs.readFileSync(path.join(root, '.context/docs/testing.md'), 'utf8')).toBe(
      '# Testing\nRun unit tests.\n',
    );
    const attestations = inspectContextAttestations(scope);
    expect(attestations.diagnostics).toEqual([]);
    expect(attestations.attestations).toHaveLength(1);
    expect(attestations.attestations[0]?.reviewer.provider).toBe('human');
    expect(
      attestations.attestations[0]?.reviewer.id !==
        attestations.attestations[0]?.author.id,
    ).toBe(true);

    // A decided draft cannot be approved twice.
    await expect(
      handlerFor(CONTEXT_DRAFT_CHANNELS.approve)(null, { draftId: draft.id }),
    ).rejects.toThrow(/proposed/i);
    // And it leaves the pending list.
    const listed = (await handlerFor(CONTEXT_DRAFT_CHANNELS.listProposed)(null)) as unknown[];
    expect(listed).toHaveLength(0);
  });
});

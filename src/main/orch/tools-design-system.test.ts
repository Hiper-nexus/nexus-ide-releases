import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
} from '../context/context-workflow-registry';
import { ensureContextScaffold } from '../context/context-doctor';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { AgentGateContext } from './gate';
import type { DesignMdApiClient } from '../design/designmd-api-client';
import { buildDesignSystemTools, designMdTestSeams } from './tools-design-system';

const stubs = {
  searchKits: vi.fn(),
  getKit: vi.fn(),
  listPopularKits: vi.fn(),
  listTags: vi.fn(),
};

const originalCreateClient = designMdTestSeams.createClient;

let baseDir = '';
let root = '';
let manager: ProjectRuntimeManager;
let scope: ProjectExecutionScope;

function context(
  providerId: string,
  sessionId: string,
  role: AgentGateContext['role'] = 'orchestrator',
  missionId?: string,
): AgentGateContext {
  return {
    token: `token-${sessionId}`,
    label: providerId,
    role,
    sessionId,
    agentName: `${providerId}-agent`,
    providerId,
    missionId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(name: string) {
  const found = buildDesignSystemTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function kitSummary() {
  return {
    slug: 'acme/clean',
    name: 'Clean UI Kit',
    description: 'A clean starter kit.',
    author: 'Acme',
    url: 'https://designmd.ai/acme/clean',
    tags: ['minimal', 'saas'],
    license: 'mit' as const,
    downloadCount: 42,
    likeCount: 7,
  };
}

function kitDetail() {
  return {
    ...kitSummary(),
    content: '# DESIGN.md\n\nUse a 4pt grid.',
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-system-runtime-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-system-')));
  scope = Object.freeze({
    version: 1,
    installationId: 'installation-tools',
    projectId: 'project-tools',
    checkoutId: 'checkout-tools',
    rootRealPath: root,
    identitySource: 'manifest',
  });
  manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  configureContextWorkflowRegistry(manager, { appVersion: 'test' });
  ensureContextScaffold(scope);
  stubs.searchKits.mockReset();
  stubs.getKit.mockReset();
  stubs.listPopularKits.mockReset();
  stubs.listTags.mockReset();
  designMdTestSeams.createClient = () =>
    ({
      searchKits: stubs.searchKits,
      getKit: stubs.getKit,
      listPopularKits: stubs.listPopularKits,
      listTags: stubs.listTags,
    }) as unknown as DesignMdApiClient;
});

afterEach(() => {
  designMdTestSeams.createClient = originalCreateClient;
  disposeContextWorkflowRegistry();
  manager.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('nexus_design_system_search', () => {
  it('returns public search results without an API key', async () => {
    stubs.searchKits.mockResolvedValue([kitSummary()]);

    const result = (await tool('nexus_design_system_search').handler({
      query: 'clean',
      tags: ['minimal'],
      sort: 'popular',
      limit: 10,
    }, context('codex', 'session-1'))) as { count: number; kits: unknown[] };

    expect(result.count).toBe(1);
    expect(result.kits[0]).toMatchObject({ slug: 'acme/clean' });
    expect(stubs.searchKits).toHaveBeenCalledWith({
      query: 'clean',
      tags: ['minimal'],
      sort: 'popular',
      limit: 10,
    });
  });
});

describe('nexus_design_system_get', () => {
  it('returns kit metadata and content using the stored API key', async () => {
    stubs.getKit.mockResolvedValue(kitDetail());

    const result = (await tool('nexus_design_system_get').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))) as { content: string; license: string };

    expect(result.content).toBe('# DESIGN.md\n\nUse a 4pt grid.');
    expect(result.license).toBe('mit');
    expect(stubs.getKit).toHaveBeenCalledWith('acme/clean');
  });

  it('propagates authentication errors from the API client', async () => {
    stubs.getKit.mockRejectedValue(new Error('missing key'));

    await expect(tool('nexus_design_system_get').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))).rejects.toThrow(/missing key/);
  });
});

describe('nexus_design_system_import', () => {
  it('creates a proposed ContextDraft with connector evidence', async () => {
    stubs.getKit.mockResolvedValue(kitDetail());

    const result = (await tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))) as {
      draftId: string;
      targetPath: string;
      status: string;
      evidencePath: string;
    };

    expect(result.status).toBe('proposed');
    expect(result.targetPath).toBe('.context/docs/design-system.md');
    expect(result.evidencePath).toMatch(/^\.context\/nexus\/evidence\/designmd-ai\//);

    const evidenceAbsolute = path.join(root, result.evidencePath);
    expect(fs.existsSync(evidenceAbsolute)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(evidenceAbsolute, 'utf8')) as Record<string, unknown>;
    expect(evidence.source).toBe('designmd.ai');
    expect(evidence.slug).toBe('acme/clean');

    // The DESIGN.md target must NOT be written yet — only the draft exists.
    expect(fs.existsSync(path.join(root, result.targetPath))).toBe(false);
    expect(result.draftId).toMatch(/\S/);
    // Evidence hash matches what would be cited as a connector source.
    expect(
      createHash('sha256').update(fs.readFileSync(evidenceAbsolute, 'utf8')).digest('hex'),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('respects a custom targetPath and hashes an existing file', async () => {
    stubs.getKit.mockResolvedValue(kitDetail());
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    const existing = '# Existing\n';
    fs.writeFileSync(path.join(root, '.context', 'docs', 'design-system.md'), existing);

    const result = (await tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
      targetPath: '.context/docs/design-system.md',
    }, context('codex', 'session-1'))) as { status: string };

    expect(result.status).toBe('proposed');
  });

  it('rejects import by workers', async () => {
    await expect(tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
    }, context('codex', 'worker-session', 'worker'))).rejects.toThrow(/workers cannot propose/);
  });

  it('blocks cc-by-sa kits by default', async () => {
    const copyleft = { ...kitDetail(), license: 'cc-by-sa' as const };
    stubs.getKit.mockResolvedValue(copyleft);

    await expect(tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))).rejects.toThrow(/cc-by-sa/);
  });
});

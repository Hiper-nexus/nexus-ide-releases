import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import {
  __resetProjectOrientationServiceForTests,
  configureProjectOrientationService,
} from '../context/orientation/orientation-service';
import { buildCodeMapTools } from './tools-code-map';

const roots: string[] = [];

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-map',
    projectId: 'project-map',
    checkoutId: 'checkout-map',
    rootRealPath: root,
    identitySource: 'provisional' as const,
  });
}

function ctx(scope: ProjectExecutionScope, role: AgentGateContext['role'] = 'orchestrator'): AgentGateContext {
  return {
    token: 'token-test',
    label: 'test',
    role,
    sessionId: 'session-1',
    agentName: 'orchestrator',
    providerId: 'claude',
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

afterEach(() => {
  __resetProjectOrientationServiceForTests();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('buildCodeMapTools', () => {
  it('exposes get/refresh/query and returns orientation snapshots', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-map-tools-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-map-cache-'));
    roots.push(root, cacheRoot);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'AuthService.ts'),
      'export class AuthService {}\n',
    );
    configureProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });

    const tools = buildCodeMapTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'nexus_code_map_get',
      'nexus_code_map_refresh',
      'nexus_code_map_query',
      'nexus_code_map_blast_radius',
    ]);

    const get = tools.find((tool) => tool.name === 'nexus_code_map_get')!;
    const snapshot = (await get.handler({}, ctx(scopeFor(root)))) as {
      mapHash: string;
      orientationMarkdown: string;
      status: string;
    };
    expect(snapshot.mapHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.orientationMarkdown).toContain('Project orientation');

    const query = tools.find((tool) => tool.name === 'nexus_code_map_query')!;
    const hits = (await query.handler(
      { q: 'Auth' },
      ctx(scopeFor(root)),
    )) as { hubs: Array<{ name: string }> };
    expect(hits.hubs.some((hub) => hub.name.includes('Auth'))).toBe(true);

    const refresh = tools.find((tool) => tool.name === 'nexus_code_map_refresh')!;
    await expect(
      refresh.handler({}, ctx(scopeFor(root), 'worker')),
    ).rejects.toThrow(/orchestrator/i);
  });

  it('acha um arquivo existente pelo nome e rotula o modo pelo estado do índice', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-map-file-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-map-cache-'));
    roots.push(root, cacheRoot);
    fs.mkdirSync(path.join(root, 'src/main'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/main/updater.ts'), 'void 0;\n');
    configureProjectOrientationService({ cacheRoot, includeContextSummary: false });
    const query = buildCodeMapTools().find((tool) => tool.name === 'nexus_code_map_query')!;
    type Result = { mode: string; paths: string[]; fallbackReason?: string };

    const first = (await query.handler({ q: 'updater' }, ctx(scopeFor(root)))) as Result;
    expect(first.paths).toContain('src/main/updater.ts');

    await vi.waitFor(async () => {
      const next = (await query.handler({ q: 'updater' }, ctx(scopeFor(root)))) as Result;
      expect(next.mode).toBe('local-index');
      expect(next.paths).toContain('src/main/updater.ts');
    });

    const miss = (await query.handler({ q: 'zzqqnothing' }, ctx(scopeFor(root)))) as Result;
    expect(miss.mode).toBe('substring');
    expect(miss.fallbackReason).toBe('no-index-hits');
  });
});

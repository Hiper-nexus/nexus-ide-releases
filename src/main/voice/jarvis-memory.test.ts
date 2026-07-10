import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  createScopedJarvisMemory,
  slugifyMemoryKey,
} from './jarvis-memory';

let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as new (file: string) => {
    close(): void;
  };
  new Database(':memory:').close();
} catch {
  sqliteAvailable = false;
}

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function fixture(): {
  parent: string;
  baseDir: string;
  scope: ProjectExecutionScope;
} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-'));
  roots.push(parent);
  const checkout = path.join(parent, 'checkout-a');
  fs.mkdirSync(checkout);
  return {
    parent,
    baseDir: path.join(parent, 'runtime'),
    scope: Object.freeze({
      version: 1,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: fs.realpathSync(checkout),
      identitySource: 'manifest',
    }),
  };
}

function manager(baseDir: string): ProjectRuntimeManager {
  const runtimeManager = new ProjectRuntimeManager({
    baseDir,
    appVersion: 'jarvis-memory-test',
  });
  managers.push(runtimeManager);
  return runtimeManager;
}

afterEach(() => {
  for (const runtimeManager of managers.splice(0)) runtimeManager.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('slugifyMemoryKey', () => {
  it('creates a stable accent-free key', () => {
    expect(slugifyMemoryKey('Preferência de Café!')).toBe('preferencia-de-cafe');
  });
});

describe.skipIf(!sqliteAvailable)('ScopedJarvisMemory', () => {
  it('isolates equal keys across projects and checkouts', () => {
    const { parent, baseDir, scope } = fixture();
    const checkoutBPath = path.join(parent, 'checkout-b');
    const projectBPath = path.join(parent, 'project-b');
    fs.mkdirSync(checkoutBPath);
    fs.mkdirSync(projectBPath);
    const checkoutB: ProjectExecutionScope = Object.freeze({
      ...scope,
      checkoutId: 'checkout-b',
      rootRealPath: fs.realpathSync(checkoutBPath),
    });
    const projectB: ProjectExecutionScope = Object.freeze({
      ...scope,
      projectId: 'project-b',
      checkoutId: 'checkout-c',
      rootRealPath: fs.realpathSync(projectBPath),
    });
    const runtimeManager = manager(baseDir);
    createScopedJarvisMemory(runtimeManager, scope).remember('deploy', 'A');
    createScopedJarvisMemory(runtimeManager, checkoutB).remember('deploy', 'B');
    createScopedJarvisMemory(runtimeManager, projectB).remember('deploy', 'C');

    expect(createScopedJarvisMemory(runtimeManager, scope).factsBlock()).toContain(
      'deploy: A',
    );
    expect(
      createScopedJarvisMemory(runtimeManager, checkoutB).factsBlock(),
    ).toContain('deploy: B');
    expect(
      createScopedJarvisMemory(runtimeManager, projectB).factsBlock(),
    ).toContain('deploy: C');
  });

  it('supersedes, soft-deletes and resurrects without cross-session cache', () => {
    const { baseDir, scope } = fixture();
    let now = 1_000;
    const runtimeManager = manager(baseDir);
    const memory = createScopedJarvisMemory(runtimeManager, scope, {
      now: () => now,
    });
    memory.remember('café', 'com açúcar');
    now += 10;
    memory.remember('café', 'sem açúcar');
    expect(memory.list()).toEqual([
      { key: 'cafe', content: 'sem açúcar', updatedAt: 1_010 },
    ]);
    expect(memory.forget('café')).toBe(true);
    expect(memory.list()).toEqual([]);
    now += 10;
    memory.remember('café', 'forte');
    expect(memory.list()[0].content).toBe('forte');
  });

  it('survives a runtime manager restart', () => {
    const { baseDir, scope } = fixture();
    const firstManager = manager(baseDir);
    createScopedJarvisMemory(firstManager, scope).remember(
      'architecture',
      'use tenant isolation',
    );
    firstManager.closeAll();
    managers.splice(managers.indexOf(firstManager), 1);

    const reopened = createScopedJarvisMemory(manager(baseDir), scope);
    expect(reopened.list()).toEqual([
      expect.objectContaining({
        key: 'architecture',
        content: 'use tenant isolation',
      }),
    ]);
  });

  it('bounds prompt output and prioritizes recent facts', () => {
    const { baseDir, scope } = fixture();
    let now = 1_000;
    const memory = createScopedJarvisMemory(manager(baseDir), scope, {
      now: () => now++,
    });
    for (let index = 0; index < 50; index += 1) {
      memory.remember(`fact-${index}`, `content ${index} with bounded text`);
    }
    const block = memory.factsBlock(200);
    expect(block.length).toBeLessThanOrEqual(200);
    expect(block).toContain('fact-49');
  });

  it('fails closed on corrupt rows and safe-read-only runtime', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    runtimeManager
      .open(scope)
      .db.prepare(
        `INSERT INTO memory_entries
           (id, kind, content, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'jarvis-fact:broken',
        'jarvis-project-fact',
        'broken',
        '{invalid',
        1,
        1,
      );
    expect(() => createScopedJarvisMemory(runtimeManager, scope).list()).toThrow(
      /invalid JARVIS project fact/i,
    );

    const readOnlyManager = {
      open: () => ({
        assertWritable: () => {
          throw new Error('safe read-only mode');
        },
        db: null,
      }),
    } as unknown as ProjectRuntimeManager;
    expect(() =>
      createScopedJarvisMemory(readOnlyManager, scope).remember('x', 'y'),
    ).toThrow(/read-only/i);
  });
});

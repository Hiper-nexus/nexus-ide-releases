import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  CONVERSATION_MAX_MESSAGES,
  createScopedJarvisConversation,
  RESUME_INJECT_MESSAGES,
  RESUME_WINDOW_MS,
} from './jarvis-conversation';

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
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conversation-'));
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
    appVersion: 'jarvis-conversation-test',
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

describe.skipIf(!sqliteAvailable)('ScopedJarvisConversation', () => {
  it('isolates identical conversation text across project checkouts', () => {
    const { parent, baseDir, scope } = fixture();
    const checkoutBPath = path.join(parent, 'checkout-b');
    fs.mkdirSync(checkoutBPath);
    const scopeB: ProjectExecutionScope = Object.freeze({
      ...scope,
      checkoutId: 'checkout-b',
      rootRealPath: fs.realpathSync(checkoutBPath),
    });
    const runtimeManager = manager(baseDir);
    createScopedJarvisConversation(runtimeManager, scope).record('status', 'A');
    createScopedJarvisConversation(runtimeManager, scopeB).record('status', 'B');

    expect(
      createScopedJarvisConversation(runtimeManager, scope).resume().at(-1),
    ).toEqual({ role: 'assistant', content: 'A' });
    expect(
      createScopedJarvisConversation(runtimeManager, scopeB).resume().at(-1),
    ).toEqual({ role: 'assistant', content: 'B' });
  });

  it('survives restart and injects only the bounded recent window', () => {
    const { baseDir, scope } = fixture();
    let now = 1_000;
    const firstManager = manager(baseDir);
    const conversation = createScopedJarvisConversation(firstManager, scope, {
      now: () => now,
    });
    for (let index = 0; index < CONVERSATION_MAX_MESSAGES; index += 1) {
      conversation.record(`user ${index}`, `assistant ${index}`);
    }
    firstManager.closeAll();
    managers.splice(managers.indexOf(firstManager), 1);

    const reopened = createScopedJarvisConversation(manager(baseDir), scope, {
      now: () => now,
    });
    expect(reopened.resume()).toHaveLength(RESUME_INJECT_MESSAGES);
    now += RESUME_WINDOW_MS + 1;
    expect(reopened.resume()).toEqual([]);
  });

  it('ignores empty pairs and persists clear', () => {
    const { baseDir, scope } = fixture();
    const runtimeManager = manager(baseDir);
    const conversation = createScopedJarvisConversation(runtimeManager, scope);
    conversation.record('', 'answer');
    conversation.record('question', '   ');
    expect(conversation.resume()).toEqual([]);
    conversation.record('question', 'answer');
    conversation.clear();
    expect(
      createScopedJarvisConversation(runtimeManager, scope).resume(),
    ).toEqual([]);
  });

  it('fails closed when runtime is safe-read-only', () => {
    const { scope } = fixture();
    const readOnlyManager = {
      open: () => ({
        assertWritable: () => {
          throw new Error('safe read-only mode');
        },
        db: null,
      }),
    } as unknown as ProjectRuntimeManager;
    expect(() =>
      createScopedJarvisConversation(readOnlyManager, scope).record('q', 'a'),
    ).toThrow(/read-only/i);
  });
});

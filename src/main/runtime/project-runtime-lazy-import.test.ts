import { describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => {
  throw new Error('native SQLite binding was evaluated during module import');
});

describe('ProjectRuntimeManager bootstrap isolation', () => {
  it('can be imported without evaluating the native SQLite module', async () => {
    const runtimeModule = await import('./project-runtime-manager');

    expect(runtimeModule.ProjectRuntimeManager).toBeTypeOf('function');
    expect(runtimeModule.createLazyProjectDatabaseFactory).toBeTypeOf('function');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearManagedAgentHookServices,
  getManagedAgentHookStatuses,
} from './managed-agent-hook-controls';
import {
  __resetDefaultInstallerRegistrationForTests,
  bootstrapManagedAgentHooks,
  registerDefaultManagedAgentHookInstallers,
} from './register-default-installers';

let home: string;

afterEach(() => {
  clearManagedAgentHookServices();
  __resetDefaultInstallerRegistrationForTests();
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('register-default-installers', () => {
  it('registers claude and codex so registry is not empty', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-default-hooks-'));
    registerDefaultManagedAgentHookInstallers({ home });
    const statuses = getManagedAgentHookStatuses();
    expect(statuses.map((s) => s.agent).sort()).toEqual(['claude', 'codex']);
  });

  it('bootstrap installs into user FS', () => {
    home = mkdtempSync(join(tmpdir(), 'nexus-default-hooks-'));
    bootstrapManagedAgentHooks({ home, enabled: true });
    const statuses = getManagedAgentHookStatuses();
    expect(statuses.every((s) => s.state === 'installed')).toBe(true);
  });
});

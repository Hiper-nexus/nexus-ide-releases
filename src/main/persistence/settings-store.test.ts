import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  app: { getPath: () => '/nonexistent-nexus-test-home' },
}));

import { getOrchSettings, replaceOrchSettings, resolveSettingsFile } from './settings-store';

const OPERATOR_FILE = path.join(os.homedir(), '.nexus', 'settings.json');

function operatorFileState(): string {
  try {
    const stat = fs.statSync(OPERATOR_FILE);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

describe('settings file isolation under test (F-932)', () => {
  it('points at the operator file only outside vitest', () => {
    expect(resolveSettingsFile({})).toBe(OPERATOR_FILE);
    const underTest = resolveSettingsFile({ VITEST: 'true' });
    expect(underTest.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(underTest)).toBe('settings.json');
    expect(underTest).not.toBe(OPERATOR_FILE);
  });

  it('a real write from a test never touches the operator settings', () => {
    const before = operatorFileState();
    const flipped = !getOrchSettings().leanCode;
    replaceOrchSettings({ leanCode: flipped });
    expect(getOrchSettings().leanCode).toBe(flipped);
    expect(operatorFileState()).toBe(before);
    const written = JSON.parse(fs.readFileSync(resolveSettingsFile(), 'utf8'));
    expect(written.orch.leanCode).toBe(flipped);
  });
});

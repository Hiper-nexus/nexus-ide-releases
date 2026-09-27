import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { linkProviderSessionState } from '../orch/cli-mcp-session-artifacts';
import { claudeConfigDirsFor } from './usage-service';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scope(checkoutId: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId,
    rootRealPath: '/workspace/project-a',
    identitySource: 'manifest',
  }) as ProjectExecutionScope;
}

describe('claudeConfigDirsFor', () => {
  it('observa as conversas por checkout onde o pane Claude de HOME privado grava (27/09)', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-dirs-'));
    tempRoots.push(tempRoot);
    const userData = path.join(tempRoot, 'userData');
    const home = path.join(tempRoot, 'home');
    const overlay = path.join(tempRoot, 'ephemeral', '.claude');
    fs.mkdirSync(overlay, { recursive: true });
    const checkoutId = 'checkout-ef0be2cb14bc9b7d14a63c2a2d4e3053';

    // O mesmo caminho que o spawn liga no HOME efêmero do pane.
    const providerSessionHome = linkProviderSessionState(
      'claude',
      overlay,
      { home, userDataPath: userData, checkoutId },
      ['projects'],
      {},
      'claude',
    );

    expect(claudeConfigDirsFor(scope(checkoutId), userData, home)).toEqual([
      path.join(home, '.claude'),
      providerSessionHome,
    ]);
  });

  it('sem userData ou com checkoutId fora do formato, fica só o ~/.claude', () => {
    expect(claudeConfigDirsFor(scope('checkout-a'), null, '/h')).toEqual(['/h/.claude']);
    expect(claudeConfigDirsFor(scope('../fuga'), '/u', '/h')).toEqual(['/h/.claude']);
  });
});

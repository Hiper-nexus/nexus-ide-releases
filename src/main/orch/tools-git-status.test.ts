import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import { buildGitTools } from './tools-git';

let root = '';

function scopeFor(rootRealPath: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'installation-git-status',
    projectId: 'project-git-status',
    checkoutId: 'checkout-git-status',
    rootRealPath,
    identitySource: 'provisional',
  });
}

function context(rootRealPath: string): AgentGateContext {
  return {
    token: 'token-git-status',
    label: 'codex',
    role: 'orchestrator',
    sessionId: 'session-git-status',
    agentName: 'codex-agent',
    providerId: 'codex',
    scope: scopeFor(rootRealPath),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function statusTool() {
  const found = buildGitTools().find(
    (candidate) => candidate.name === 'nexus_git_status',
  );
  if (!found) throw new Error('missing nexus_git_status');
  return found;
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-status-')),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nexus_git_status', () => {
  it('reports a non-repo workspace root as a fact, not a failure', async () => {
    // Raiz multi-projeto (ex.: ~/dev) não é repo — o erro antigo
    // "Git executable-config inspection failed" mandava o agente caçar
    // um bug inexistente.
    await expect(
      statusTool().handler({}, context(root)),
    ).resolves.toMatchObject({
      isRepo: false,
      note: expect.stringContaining('não é um repositório git'),
    });
  });

  it('keeps reporting real repositories with isRepo true', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await expect(
      statusTool().handler({}, context(root)),
    ).resolves.toMatchObject({
      isRepo: true,
      output: expect.stringContaining('##'),
    });
  });
});

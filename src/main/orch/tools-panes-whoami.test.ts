import { describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import { effectPolicyForTool } from './mcp-effect-policy';
import { buildPaneTools } from './tools-panes';
import {
  forgetAccountChoiceReceipt,
  recordAccountChoiceReceipt,
} from '../persistence/account-choice-receipts';
import type { AccountChoiceReceipt } from '../../shared/account-choice';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'install-1',
  projectId: 'project-1',
  checkoutId: 'checkout-1',
  rootRealPath: '/workspace',
  identitySource: 'provisional',
});

function context(): AgentGateContext {
  return {
    token: 'secret-bearer-token',
    label: 'Frontend worker',
    role: 'worker',
    sessionId: 'session-1',
    missionId: 'mission-1',
    contextRevision: 'ctx-1',
    agentName: 'Frontend',
    providerId: 'codex',
    scope,
    executionScope: Object.freeze({ ...scope, rootRealPath: '/workspace/.worktrees/task-1' }),
    allowedTools: ['nexus_file_read'],
    allowedSkills: ['react-best-practices'],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

describe('nexus_pane_whoami', () => {
  it('returns effective self authority without leaking the bearer token', async () => {
    const tool = buildPaneTools().find((candidate) => candidate.name === 'nexus_pane_whoami');
    expect(tool).toBeDefined();
    const result = await tool!.handler({}, context());
    expect(result).toMatchObject({
      role: 'worker',
      missionId: 'mission-1',
      agentName: 'Frontend',
      providerId: 'codex',
      executionRoot: '/workspace/.worktrees/task-1',
      // F-1157: the lists are seal records; access is open.
      access: 'all-tools-and-skills',
      readOnlyEnforced: false,
      recordedTools: ['nexus_file_read'],
    });
    expect(result).not.toHaveProperty('allowedTools');
    expect(JSON.stringify(result)).not.toContain('secret-bearer-token');
    expect(effectPolicyForTool(tool!.name)).toBe('read-only');
  });

  it('devolve o recibo da escolha de conta da própria sessão', async () => {
    const tool = buildPaneTools().find(
      (candidate) => candidate.name === 'nexus_pane_whoami',
    )!;
    const receipt: AccountChoiceReceipt = {
      adapterId: 'codex',
      source: 'active',
      account: { label: 'g•••@l•••.com.br', mode: 'subscription' },
      headroom: null,
      alternatives: [],
      decidedAt: 1,
    };
    recordAccountChoiceReceipt('session-1', receipt);
    try {
      const result = await tool.handler({}, context());
      expect(result).toMatchObject({ account: receipt });
      expect(JSON.stringify(result)).not.toContain('gabriel@');
    } finally {
      forgetAccountChoiceReceipt('session-1');
    }
    const bare = await tool.handler({}, context());
    expect(bare).toMatchObject({ account: null });
  });
});

describe('F-1166: dicas consultivas da própria missão no whoami', () => {
  it('expõe só as dicas da missão do chamador; sem dica, sem campo', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const hints = await import('./mission-decision-hints');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoami-hints-'));
    hints.configureMissionDecisionHints(dir);
    try {
      const tool = buildPaneTools().find((candidate) => candidate.name === 'nexus_pane_whoami')!;
      expect(await tool.handler({}, context())).not.toHaveProperty('decisionHints');
      const receipt = { at: 1, model: 'jev', usd: null, probabilities: {} };
      hints.recordKickoffHint('mission-1', { ...receipt, origin: 'conventional', complexity: 1, complexityLevel: 'small',
        workers: 1, maxWorkers: 2, lane: 'standard', laneConfidence: 0.9 });
      hints.recordCompletionHint('mission-other', { ...receipt, coverage: 0.1, warning: true, handoffCount: 0, signature: 's', consultations: 1 });
      const result = await tool.handler({}, context()) as { decisionHints?: Record<string, unknown> };
      expect(result.decisionHints).toMatchObject({ kickoff: { workers: 1, lane: 'standard' } });
      expect(result.decisionHints).not.toHaveProperty('completion');
      await hints.flushMissionDecisionHints();
    } finally {
      hints.configureMissionDecisionHints(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('F-1166 P1: dica de recuperação exposta não casa no limit-detector', () => {
  it('JSON exposto com dica de recuperação e de cobertura: zero casamentos', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const hints = await import('./mission-decision-hints');
    const advisorModule = await import('./jev-mission-advisor');
    const { detectLimit } = await import('./limit-detector');
    const LIMIT_TEXT = 'Error: 429 Too Many Requests';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-echo-'));
    hints.configureMissionDecisionHints(dir);
    try {
      const deps = { enabled: () => true, hasKey: () => true };
      const answer = (answers: Record<string, unknown>) => async () => ({ model: 'jev', answers, usage: { input_tokens: 1, output_tokens: 0 } }) as never;
      // Classe vinda do detector real sobre o texto de limite; o texto não entra.
      await advisorModule.adviseRecovery({ missionId: 'mission-1', paneId: 'p', adapterId: 'claude',
        triggerClass: advisorModule.recoveryTriggerClass({ limitKind: detectLimit(LIMIT_TEXT)!.kind }) },
      { ...deps, judge: answer({ next_step: { type: 'choice', choice: 'retry-same-cli', probabilities: {}, confidence: 0.9 } }) });
      await advisorModule.adviseCompletionCheck({ missionId: 'mission-1', goal: 'g', acceptanceCriteria: [LIMIT_TEXT], handoffs: [] },
        { ...deps, judge: answer({ covers_goal: { type: 'noul', noul: 0.2 }, missing: { type: 'choice', choice: 'c1', probabilities: {}, confidence: 0.9 } }) });
      const tool = buildPaneTools().find((candidate) => candidate.name === 'nexus_pane_whoami')!;
      const exposed = await tool.handler({}, context());
      const text = JSON.stringify(exposed, null, 2);
      expect(text).toContain('rate-limit');
      expect(detectLimit(text)).toBeNull();
      for (const line of text.split('\n')) expect(detectLimit(line)).toBeNull();
      await hints.flushMissionDecisionHints();
    } finally {
      hints.configureMissionDecisionHints(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

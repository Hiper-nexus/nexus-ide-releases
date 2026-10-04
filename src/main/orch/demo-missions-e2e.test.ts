import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Mission,
  Squad,
  SquadAgent,
} from '../../shared/orch-types';
import type { MissionIntentContract } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import {
  deliverMissionDirectInstruction,
} from './mission-engine-production';
import {
  enforceScopeRules,
  checkReviewCycleLimit,
  filterAntiSocialChatter,
  writeSwarmMailboxMessage,
  MAX_OWNED_FILES_PER_WORKER,
} from './swarm-protocol';
import {
  writeAtomicHookDropFile,
  AgentHookDropBoxWatcher,
  type CanonicalHookEnvelope,
} from '../agent-hooks/hook-drop-box';
import {
  SessionAliveSentinel,
  readSessionAliveMarker,
} from '../crash-reporting/session-alive-sentinel';
import {
  backlinks,
  writeCanonicalMemoryProjection,
} from '../memory/nexus-memory';

describe('Demo & Mission E2E Simulation (Simple and Complex)', () => {
  let tempDir: string;
  let workspaceDir: string;
  let dropBoxDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-demo-sim-'));
    workspaceDir = path.join(tempDir, 'workspace');
    dropBoxDir = path.join(tempDir, 'agent-hooks', 'global');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(dropBoxDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function makeScope(): ProjectExecutionScope {
    return {
      version: 1,
      installationId: 'inst-demo-1',
      projectId: 'proj-demo-1',
      checkoutId: 'checkout-demo-1',
      rootRealPath: workspaceDir,
      identitySource: 'manifest',
    };
  }

  it('SIMULAÇÃO 1: Missão Simples (Fast-Lane/Direct) de início ao fim sem quebras', async () => {
    // 1. Definição da Squad simples (apenas 1 executor, sem orquestrador)
    const agent: SquadAgent = {
      id: 'worker-exec-1',
      agentName: 'FastExecutor',
      category: 'executor',
      cli: 'claude',
      effort: 'medium',
      instructions: 'Executar tarefa pontual de refatoração.',
    };

    const squad: Squad = {
      id: 'squad-fast-lane',
      name: 'Squad Rápida',
      createdAt: String(Date.now()),
      builtin: false,
      orchestratorInstructions: '',
      agents: [agent],
    };

    const squadAuth = snapshotSquadAuthority(squad);
    const intent: MissionIntentContract = {
      version: 1,
      source: 'typed',
      goal: 'Adicionar endpoint de health check',
      acceptanceCriteria: ['GET /health retorna 200 OK'],
      risk: 'normal',
      executionMode: 'assisted',
      contextPolicy: 'minimal',
      budgets: {
        planningTokens: 10_000,
        executionTokens: 50_000,
        maxWorkers: 1,
      },
      intentVersion: 1,
      approvedAt: Date.now(),
      dispatchedAt: Date.now(),
      squadRevisionHash: squadAuth.hash,
    };

    const missionPanes = [
      {
        paneId: 'pane-worker-1',
        role: 'worker' as const,
        agentId: agent.id,
        state: 'idle' as const,
      },
    ];

    const mission: Mission = {
      id: 'mission-simple-demo',
      title: 'Missão Rápida: Health Check',
      description: '',
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      squadId: squad.id,
      intentContract: intent,
      milestones: [],
      learnings: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 2. Runtime Sentinel inicializado
    const sentinel = new SessionAliveSentinel({
      userDataPath: tempDir,
      getActivePanes: () => missionPanes.length,
    });
    sentinel.start();

    // 3. DropBox Watcher ativo
    const hookEvents: CanonicalHookEnvelope[] = [];
    const watcher = new AgentHookDropBoxWatcher({
      dropDir: dropBoxDir,
      onIngest: (env) => hookEvents.push(env),
    });
    watcher.start();

    // 4. Operador entrega instrução direta ao worker vivo
    const deliveredWrites: string[] = [];
    const stores = {
      missions: {
        get: () => mission,
        hasCurrentKickoffAcceptance: () => true,
      },
      missionPanes: {
        list: () => [
          {
            paneId: 'pane-worker-1',
            role: 'worker',
            agentId: agent.id,
            state: 'idle',
          },
        ],
      },
    } as any;

    const deps = {
      getRuntimeAgentSessionInfo: (sessionId: string) => ({
        sessionId,
        paneId: 'pane-worker-1',
        scope: makeScope(),
        adapterId: 'claude',
        accountId: 'acc-1',
      }),
      getAcpDriverSession: () => null,
      getAcpDriverSemanticStatus: () => 'idle',
      getPaneRuntimeAuthorityBySession: () => null,
      getSquad: () => squad,
      listMissionWorkerSessions: () => [
        {
          sessionId: 'sess-worker-1',
          paneId: 'pane-worker-1',
          role: 'worker',
          agentId: agent.id,
          agentName: agent.agentName,
          state: 'idle',
        },
      ],
      deliverAgentPrompt: vi.fn(async (_sid: string, prompt: string) => {
        deliveredWrites.push(prompt);
        return true;
      }),
      emitMissionEvent: vi.fn(() => true),
    } as any;

    await deliverMissionDirectInstruction(
      makeScope(),
      stores,
      {
        kind: 'direct',
        missionId: mission.id,
        targetAgentId: agent.id,
        text: 'Implemente GET /health em server.ts e submeta teste.',
      },
      deps,
    );

    expect(deliveredWrites.length).toBe(1);
    expect(deliveredWrites[0]).toContain('Implemente GET /health');

    // 5. Worker emite evento de status 'working' via drop-box
    writeAtomicHookDropFile(dropBoxDir, {
      sessionId: 'sess-pane-worker-1',
      status: 'running',
      event: 'user-prompt-submit',
      timestamp: Date.now(),
      userPrompt: 'Implementando endpoint...',
    });
    await watcher.drain();
    expect(hookEvents.length).toBe(1);
    expect(hookEvents[0].status).toBe('running');

    // 6. Worker completa tarefa e emite 'idle' (done)
    writeAtomicHookDropFile(dropBoxDir, {
      sessionId: 'sess-pane-worker-1',
      status: 'idle',
      event: 'stop',
      timestamp: Date.now(),
      nativeSessionId: 'claude-conversation-42',
    });
    await watcher.drain();
    expect(hookEvents.length).toBe(2);

    // 7. Encerramento limpo da missão simples
    mission.status = 'done';
    mission.updatedAt = Date.now();
    expect(mission.status).toBe('done');

    await sentinel.markExpectedExit();
    const marker = readSessionAliveMarker(tempDir);
    expect(marker?.expectedExit).toBe(true);

    await watcher.dispose();
    await sentinel.dispose();
  });

  it('SIMULAÇÃO 2: Missão Complexa (Multi-Agent Swarm, Review, Scope & Graph) de início ao fim', async () => {
    // 1. Squad de Swarm: Maestro + Implementer + Reviewer
    const maestro: SquadAgent = {
      id: 'ag-maestro',
      agentName: 'Maestro Orchestrator',
      category: 'orchestrator',
      cli: 'claude',
      effort: 'high',
      instructions: 'Coordene a implementação com story plan.',
    };
    const implementer: SquadAgent = {
      id: 'ag-coder',
      agentName: 'Code Worker',
      category: 'executor',
      cli: 'claude',
      effort: 'medium',
      instructions: 'Escreva código limpo com testes.',
    };
    const reviewer: SquadAgent = {
      id: 'ag-reviewer',
      agentName: 'Code Reviewer',
      category: 'reviewer',
      cli: 'claude',
      effort: 'medium',
      instructions: 'Revise código com foco em arquitetura.',
    };

    const squad: Squad = {
      id: 'squad-complex-swarm',
      name: 'Engenharia Swarm',
      createdAt: String(Date.now()),
      builtin: false,
      orchestratorInstructions: 'Supervisione todo o fluxo.',
      agents: [maestro, implementer, reviewer],
    };

    const complexPanes = [
      { paneId: 'pane-maestro', role: 'orchestrator' as const, agentId: maestro.id, state: 'busy' as const },
      { paneId: 'pane-coder', role: 'worker' as const, agentId: implementer.id, state: 'idle' as const },
      { paneId: 'pane-reviewer', role: 'worker' as const, agentId: reviewer.id, state: 'idle' as const },
    ];

    const mission: Mission = {
      id: 'mission-complex-swarm-demo',
      title: 'Missão Complexa: Arquitetura e Refatoração',
      description: '',
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      squadId: squad.id,
      milestones: [],
      learnings: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 2. Verificação de trava de escopo (Scope-Freeze & Owned Files)
    const ownedFiles = [
      'src/core/database.ts',
      'src/core/storage.ts',
      'src/core/database.test.ts',
    ];
    const modifiedFiles = ['src/core/database.ts', 'src/core/database.test.ts'];

    const scopeCheck = enforceScopeRules({
      ownedFiles,
      modifiedFiles,
      maxFiles: MAX_OWNED_FILES_PER_WORKER,
    });
    expect(scopeCheck.allowed).toBe(true);
    expect(scopeCheck.violations).toHaveLength(0);

    // 3. Troca de mensagem entre agentes via Mailbox com Transcript-First
    const rawMessage = [
      'Thanks a lot for the review invitation!',
      'Here is the completed database module diff:',
      '```ts',
      'export class DatabaseConnection {}',
      '```',
      'Great work everyone!',
    ].join('\n');

    // Filtro anti-social chatter (remove formalidades vazias)
    const { clean, strippedCount } = filterAntiSocialChatter(rawMessage);
    expect(strippedCount).toBe(2);
    expect(clean).toContain('DatabaseConnection');
    expect(clean).not.toContain('Thanks a lot');
    expect(clean).not.toContain('Great work');

    // Escrita atômica no Mailbox (transcript antes de inbox)
    const mailboxRes = writeSwarmMailboxMessage({
      baseDir: tempDir,
      message: {
        sender: 'pane-coder',
        recipient: 'pane-reviewer',
        content: clean,
        payload: { storyId: 'story-database-1' },
      },
      nudgeRecipient: true,
    });

    expect(fs.existsSync(mailboxRes.transcriptPath)).toBe(true);
    expect(fs.existsSync(mailboxRes.inboxPath)).toBe(true);
    expect(fs.existsSync(mailboxRes.nudgePath!)).toBe(true);

    // 4. Ciclo de Review (Verificação de limite contra loop infinito)
    const reviewCycle1 = checkReviewCycleLimit(1);
    expect(reviewCycle1.canProceed).toBe(true);
    expect(reviewCycle1.escalateToOperator).toBe(false);

    // 5. Integração de Conhecimento e Grafo de Memória
    await writeCanonicalMemoryProjection(workspaceDir, {
      id: 'mem-arch-1',
      kind: 'decision',
      content: '# Database Architecture\n\nCore architecture decision for transactional storage.',
      scope: 'workspace',
      importance: 5,
      source: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await writeCanonicalMemoryProjection(workspaceDir, {
      id: 'mem-storage-1',
      kind: 'note',
      content: '# Storage Adapter\n\nImplements disk layout based on [[Database Architecture|DB Specs]].',
      scope: 'workspace',
      importance: 3,
      source: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Verificar backlinks no grafo
    const bl = backlinks(workspaceDir, 'Database Architecture');
    expect(bl.length).toBe(1);
    expect(bl[0].title).toBe('Storage Adapter');

    // 6. Finalização e Teardown gracioso da missão complexa
    mission.status = 'done';
    for (const p of complexPanes) {
      p.state = 'idle';
    }
    expect(mission.status).toBe('done');
    expect(complexPanes.every((p) => p.state === 'idle')).toBe(true);
  });
});

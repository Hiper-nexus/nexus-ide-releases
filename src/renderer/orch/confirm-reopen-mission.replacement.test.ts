import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { Mission, Squad } from '../../shared/orch-types';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { resumeIntentFirstMissionShell } from './confirm-reopen-mission';

const workspace = {
  path: '/workspace',
  name: 'workspace',
  lastOpenedAt: 1,
};
const squad: Squad = {
  id: 'saved-squad',
  name: 'Equipe salva',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: 'Coordene a missão.',
  agents: [
    {
      id: 'coordinator',
      agentName: 'Coordenar',
      category: 'orchestrator',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['nexus_task'],
      allowedSkills: [],
    },
    {
      id: 'maker',
      agentName: 'Implementar',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['Read', 'Edit'],
      allowedSkills: [],
    },
  ],
};
const legacyShell: Mission = {
  id: 'legacy-shell',
  title: 'Continuar o checkout',
  description: 'Descrição antiga que não deve vencer o contrato.',
  status: 'pending',
  squadId: squad.id,
  milestones: [],
  learnings: '',
  intentState: 'ready_to_start',
  intentVersion: 3,
  intentContract: compileIntentContract({
    goal: 'Corrigir o total do checkout e provar o resultado.',
    source: 'typed',
    intentVersion: 3,
    lane: 'consult',
    contextPolicy: 'minimal',
    contextPaths: ['src/checkout.ts'],
    acceptanceCriteria: ['O total correto é exibido.'],
  }),
  createdAt: 1,
  updatedAt: 2,
};

function entryContext(): unknown {
  const state: unknown = useMissionSetupStore.getState();
  if (!state || typeof state !== 'object' || !('entryContext' in state)) {
    return null;
  }
  return state.entryContext;
}

describe('legacy intent-shell replacement', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ current: workspace });
    useOrchStore.setState({ squads: [squad], missions: [legacyShell] });
    useMissionSetupStore.setState({
      workspacePath: workspace.path,
      draft: {
        objective: '',
        title: '',
        contextPaths: [],
        roster: [],
        advanced: { lane: 'standard' },
        step: 'mission',
        revision: 0,
      },
      persistence: { status: 'idle' },
      workspaceDrafts: {},
      entryContext: { kind: 'pet-studio', revision: 1 },
    } as never);
    useProductNavigationStore.setState({
      destination: { kind: 'terminal' },
      settingsReturnDestination: null,
    });
    vi.stubGlobal('window', {
      nexus: {
        orch: {
          removeMission: vi.fn(async () => ({ removed: true })),
        },
      },
    });
  });

  it('seeds canonical Mission Setup from the saved squad without removing the old shell', () => {
    expect(resumeIntentFirstMissionShell(legacyShell)).toEqual({
      ok: true,
      panes: 0,
      intentShell: true,
    });

    expect(useMissionSetupStore.getState()).toMatchObject({
      workspacePath: workspace.path,
      draft: {
        title: legacyShell.title,
        objective: legacyShell.intentContract?.goal,
        contextPaths: legacyShell.intentContract?.contextPaths,
        roster: squad.agents.map((agent) => ({
          ...agent,
          allowedTools: ['Read'],
        })),
        advanced: { lane: 'consult' },
        step: 'review',
      },
    });
    expect(entryContext()).toEqual({
      kind: 'legacy-replacement',
      supersededMissionId: legacyShell.id,
      acceptanceCriteria: legacyShell.intentContract?.acceptanceCriteria,
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(window.nexus.orch.removeMission).not.toHaveBeenCalled();
  });

  it('fails closed when the saved squad disappeared and keeps the shell untouched', () => {
    useOrchStore.setState({ squads: [] });

    expect(resumeIntentFirstMissionShell(legacyShell)).toMatchObject({
      ok: false,
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
    expect(useMissionSetupStore.getState().draft.objective).toBe('');
    expect(entryContext()).toBeNull();
    expect(window.nexus.orch.removeMission).not.toHaveBeenCalled();
  });
});

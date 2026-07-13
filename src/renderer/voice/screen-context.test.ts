import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { buildScreenSnapshot } from './screen-context';

function pane(patch: Partial<PaneModel> & Pick<PaneModel, 'id'>): PaneModel {
  return {
    kind: 'shell',
    title: patch.id,
    ...patch,
  };
}

describe('buildScreenSnapshot', () => {
  it('includes focused browser URL, pane roles, orchestrator, and missions', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'nexus-ide',
      viewKind: 'canvas',
      focusedPaneId: 'browser-1',
      orchestratorPaneId: 'agent-1',
      activeMissions: ['Ship voice parity (running)'],
      panes: [
        pane({ id: 'shell-1', title: 'main terminal', kind: 'shell' }),
        pane({
          id: 'browser-1',
          title: 'Preview',
          kind: 'browser',
          browserUrl: 'https://example.com/docs',
        }),
        pane({
          id: 'agent-1',
          title: 'Orq',
          kind: 'cli-agent',
          role: 'orchestrator',
        }),
      ],
      surface: { kind: 'workspace' as const, blockingOverlays: [] as string[] },
    });

    expect(snapshot.context).toContain('Workspace: nexus-ide');
    expect(snapshot.context).toContain('[browser; id=browser-1] Preview @ https://example.com/docs');
    expect(snapshot.context).toContain('Focused: [browser; id=browser-1] Preview @ https://example.com/docs');
    expect(snapshot.context).toContain('Active orchestrator: Orq');
    expect(snapshot.context).toContain('Ship voice parity');
    expect(snapshot.context.length).toBeLessThanOrEqual(900);
    expect(snapshot.wakePrompt).toContain('browser Preview');
    expect(snapshot.wakePrompt).not.toContain('[browser]');
  });

  it('summarizes the home deck with visible actions and ready squads', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'cashback',
      viewKind: 'grid',
      focusedPaneId: null,
      orchestratorPaneId: null,
      activeMissions: [],
      panes: [],
      surface: {
        kind: 'home' as const,
        readySquads: ['Code Review', 'QA Swarm'],
        hiddenShellCount: 0,
      },
    });

    expect(snapshot.context).toContain('home deck open');
    expect(snapshot.context).toContain('visible actions: start mission, custom squad, terminal');
    expect(snapshot.context).toContain('ready squads: Code Review, QA Swarm');
    expect(snapshot.wakePrompt).toContain('Pronto para operar');
  });

  it('warns when home deck hides existing shell panes', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'cashback',
      viewKind: 'grid',
      focusedPaneId: 'shell-1',
      orchestratorPaneId: null,
      activeMissions: [],
      panes: [pane({ id: 'shell-1', title: 'main', kind: 'shell' })],
      surface: { kind: 'home', readySquads: [], hiddenShellCount: 1 },
    });

    expect(snapshot.context).toContain('shell pane(s) exist underneath but are NOT visible');
    expect(snapshot.wakePrompt).toContain('terminal por baixo');
  });

  it('reports operator profile overlay blocking panes', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'nexus-ide',
      viewKind: 'grid',
      focusedPaneId: 'shell-1',
      orchestratorPaneId: null,
      activeMissions: [],
      panes: [pane({ id: 'shell-1', title: 'main', kind: 'shell' })],
      surface: { kind: 'operator-profile' },
    });

    expect(snapshot.context).toContain('operator profile overlay open');
    expect(snapshot.context).toContain('terminal NOT visible');
  });

  it('reports the exact mission wizard step and saved squad choices', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'nexus-ide',
      viewKind: 'grid',
      focusedPaneId: null,
      orchestratorPaneId: null,
      activeMissions: [],
      panes: [],
      surface: {
        kind: 'wizard',
        mode: 'nova missão',
        step: 'mode',
        visibleActions: ['Modo Livre', 'Modo Squad', 'Modo Agêntico'],
        readySquads: ['Code Review', 'QA Swarm'],
      },
    });

    expect(snapshot.context).toContain('visible step: mode');
    expect(snapshot.context).toContain('visible actions: Modo Livre, Modo Squad, Modo Agêntico');
    expect(snapshot.context).toContain('saved squads: Code Review, QA Swarm');
    expect(snapshot.wakePrompt).toContain('escolha de modo');
  });

  it('lists blocking overlays on workspace surface', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'nexus-ide',
      viewKind: 'grid',
      focusedPaneId: 'shell-1',
      orchestratorPaneId: null,
      activeMissions: [],
      panes: [pane({ id: 'shell-1', title: 'main', kind: 'shell' })],
      surface: { kind: 'workspace', blockingOverlays: ['perfil operador'] },
    });

    expect(snapshot.context).toContain('blocking overlays: perfil operador');
  });

  it('keeps context inside the Jarvis IPC screen schema limit', () => {
    const panes = Array.from({ length: 12 }, (_, index) =>
      pane({
        id: `pane-${index}`,
        title: `very long pane title ${index} `.repeat(8),
        kind: index % 2 === 0 ? 'cli-agent' : 'shell',
      }),
    );

    const snapshot = buildScreenSnapshot({
      workspaceName: 'very-long-workspace-name',
      viewKind: 'canvas',
      focusedPaneId: 'pane-0',
      orchestratorPaneId: null,
      activeMissions: [
        'Mission A with a long title (running)',
        'Mission B with a long title (review)',
      ],
      panes,
      surface: {
        kind: 'wizard',
        mode: 'novo workspace',
        step: 'mode',
        visibleActions: ['Modo Livre', 'Modo Squad', 'Modo Agêntico'],
        readySquads: [],
      },
    });

    expect(snapshot.context.length).toBeLessThanOrEqual(900);
    expect(snapshot.context).toContain('...');
  });
});

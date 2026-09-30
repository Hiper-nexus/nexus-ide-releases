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

  it('reports settings destination open and handles wake prompts', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'nexus-ide',
      focusedPaneId: null,
      orchestratorPaneId: null,
      activeMissions: [],
      panes: [],
      surface: { kind: 'settings' },
    });

    expect(snapshot.context).toContain('settings destination open: providers, accounts, catalog, media, shortcuts, modules');
    expect(snapshot.wakePrompt).toContain('Estou nas configuracoes. Quer ajustar providers, keys ou outro modulo?');
  });
  it('lists blocking overlays on workspace surface', () => {
    const snapshot = buildScreenSnapshot({
      workspaceName: 'nexus-ide',
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
      focusedPaneId: 'pane-0',
      orchestratorPaneId: null,
      activeMissions: [
        'Mission A with a long title (running)',
        'Mission B with a long title (review)',
      ],
      panes,
      surface: {
        kind: 'workspace',
        blockingOverlays: [],
      },
    });

    expect(snapshot.context.length).toBeLessThanOrEqual(900);
    expect(snapshot.context).toContain('...');
  });
});

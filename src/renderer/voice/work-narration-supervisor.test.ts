import { describe, expect, it } from 'vitest';
import { WorkNarrationSupervisor } from './work-narration-supervisor';

describe('WorkNarrationSupervisor', () => {
  it('accepts the visible mission once and dedupes its replay', () => {
    const supervisor = new WorkNarrationSupervisor();
    const event = { text: 'Build terminou', eventId: 'h-1', missionId: 'm-1' };
    expect(supervisor.accept(event, { focusedMissionId: 'm-1' })).toBe(true);
    expect(supervisor.accept(event, { focusedMissionId: 'm-1' })).toBe(false);
  });

  it('fails closed for a different visible mission', () => {
    expect(new WorkNarrationSupervisor().accept(
      { text: 'Resultado antigo', missionId: 'm-old' },
      { focusedMissionId: 'm-current' },
    )).toBe(false);
  });

  it('accepts project-level updates and rejects pane-only cross-talk', () => {
    const supervisor = new WorkNarrationSupervisor();
    expect(supervisor.accept({ text: 'Squad pronto' }, {})).toBe(true);
    expect(supervisor.accept(
      { text: 'Pergunta do outro pane', paneId: 'pane-b' },
      { focusedPaneId: 'pane-a' },
    )).toBe(false);
  });
});

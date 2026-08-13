import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrchStore } from '../state/orch-store';

const {
  getPaneSessionId,
  submitPromptToPane,
  submitPromptToPaneOperatorInput,
} = vi.hoisted(() => ({
  getPaneSessionId: vi.fn<(paneId: string) => string | null>(
    () => 'session-worker',
  ),
  submitPromptToPane: vi.fn<(paneId: string, text: string) => boolean>(
    () => true,
  ),
  submitPromptToPaneOperatorInput: vi.fn<
    (paneId: string, text: string, sessionId: string) => Promise<boolean>
  >(async () => true),
}));

vi.mock('./terminal-host', () => ({
  getPaneSessionId,
  submitPromptToPane,
  submitPromptToPaneOperatorInput,
}));

import { submitLivePanePrompt } from './submit-live-pane-prompt';

describe('submitLivePanePrompt — mesma lane do teclado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPaneSessionId.mockReturnValue('session-worker');
    useOrchStore.setState({ paneMissions: {} });
  });

  it('worker de missão usa a lane do operador, nunca o write cru', async () => {
    const sent = await submitLivePanePrompt(
      { id: 'pane-worker', kind: 'cli-agent', missionId: 'mission-1' },
      'Consolide agora com nexus_handoff_submit',
    );

    expect(sent).toBe(true);
    expect(submitPromptToPaneOperatorInput).toHaveBeenCalledWith(
      'pane-worker',
      'Consolide agora com nexus_handoff_submit',
      'session-worker',
    );
    expect(submitPromptToPane).not.toHaveBeenCalled();
  });

  it('shell plano continua na lane crua', async () => {
    getPaneSessionId.mockReturnValue('session-shell');
    const sent = await submitLivePanePrompt(
      { id: 'pane-shell', kind: 'shell' },
      'ls',
    );

    expect(sent).toBe(true);
    expect(submitPromptToPane).toHaveBeenCalledWith('pane-shell', 'ls');
    expect(submitPromptToPaneOperatorInput).not.toHaveBeenCalled();
  });

  it('sem sessão viva recusa sem escrever', async () => {
    getPaneSessionId.mockReturnValue(null);
    const sent = await submitLivePanePrompt(
      { id: 'pane-worker', kind: 'cli-agent', missionId: 'mission-1' },
      'handoff',
    );

    expect(sent).toBe(false);
    expect(submitPromptToPane).not.toHaveBeenCalled();
    expect(submitPromptToPaneOperatorInput).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  deadTerminalPaneClosesDirectly,
  paneCloseNeedsConfirmation,
  paneMissionLinkIsTerminal,
} from './pane-close-guard';

describe('paneCloseNeedsConfirmation', () => {
  it('protects busy and spawning terminal processes', () => {
    expect(paneCloseNeedsConfirmation('cli-agent', 'busy')).toBe(true);
    expect(paneCloseNeedsConfirmation('cli-agent', 'spawning')).toBe(true);
    expect(paneCloseNeedsConfirmation('shell', 'busy')).toBe(true);
  });

  it('allows completed, sleeping, idle and browser panes to close directly', () => {
    expect(paneCloseNeedsConfirmation('cli-agent', 'idle')).toBe(false);
    expect(paneCloseNeedsConfirmation('cli-agent', 'exited')).toBe(false);
    expect(paneCloseNeedsConfirmation('shell', 'hibernated')).toBe(false);
    expect(paneCloseNeedsConfirmation('browser', 'busy')).toBe(false);
  });
});

describe('deadTerminalPaneClosesDirectly — cadáver não finge processo ativo', () => {
  it('pane sem sessão de missão terminal fecha direto', () => {
    expect(
      deadTerminalPaneClosesDirectly({
        hasLiveSession: false,
        missionTerminalOrUnlinked: true,
      }),
    ).toBe(true);
  });

  it('sessão viva mantém a proteção atual', () => {
    expect(
      deadTerminalPaneClosesDirectly({
        hasLiveSession: true,
        missionTerminalOrUnlinked: true,
      }),
    ).toBe(false);
  });

  it('missão viva mantém a confirmação mesmo sem sessão visível', () => {
    expect(
      deadTerminalPaneClosesDirectly({
        hasLiveSession: false,
        missionTerminalOrUnlinked: false,
      }),
    ).toBe(false);
  });
});

describe('paneMissionLinkIsTerminal — vínculos órfãos e terminais', () => {
  it('trata missão inexistente/órfã como terminal para não travar pane', () => {
    expect(
      paneMissionLinkIsTerminal('pane-1', {
        id: 'pane-1',
        title: 'Agent 1',
        kind: 'cli-agent',
        missionId: 'orphaned-mission-999',
      }),
    ).toBe(true);
  });

  it('trata pane sem missionId como terminal/unlinked', () => {
    expect(
      paneMissionLinkIsTerminal('pane-2', {
        id: 'pane-2',
        title: 'Terminal 2',
        kind: 'shell',
      }),
    ).toBe(true);
  });
});

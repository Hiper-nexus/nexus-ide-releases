/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneBirthOverlay } from './PaneBirthOverlay';
import {
  PANE_BIRTH_FAILED_AFTER_MS,
  PANE_BIRTH_SLOW_AFTER_MS,
  clearPaneBirthElapsed,
  paneBirthClockKey,
} from '../lib/pane-birth-display';
import { useSessionStateStore } from '../state/session-state-store';
import {
  clearPaneSpawnError,
  recordPaneSpawnError,
} from '../terminal/pane-spawn-errors';
import type { PaneModel } from '../../shared/types';
import { useAccountReloginIntentStore } from '../state/account-relogin-intent';
import { useProductNavigationStore } from '../state/product-navigation-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const sessionListeners = new Set<
  (paneId: string, sessionId: string | null) => void
>();
let liveSessionId: string | null = null;

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: () => liveSessionId,
  onPaneSessionChange: (cb: (paneId: string, sessionId: string | null) => void) => {
    sessionListeners.add(cb);
    return () => sessionListeners.delete(cb);
  },
}));

const PANE: PaneModel = {
  id: 'pane-birth',
  kind: 'cli-agent',
  title: 'Codex',
  adapterId: 'codex',
  agentName: 'Codex Dev',
  model: 'gpt-5.6-sol',
} as PaneModel;

const roots: Root[] = [];

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<PaneBirthOverlay pane={PANE} />));
  return host;
}

beforeEach(() => {
  liveSessionId = null;
  clearPaneBirthElapsed(paneBirthClockKey(PANE.id, PANE.adapterId));
  sessionListeners.clear();
  useSessionStateStore.setState({
    paneStates: new Map(),
    displayStates: new Map(),
  } as never);
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('PaneBirthOverlay', () => {
  it('explains the empty terminal while the session is being born', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const host = mount();
    expect(host.textContent).toContain('Preparando agente…');
    expect(host.textContent).toContain('Codex Dev');
    expect(host.textContent).toContain('gpt-5.6-sol');
  });

  it('leaves the tree as soon as the PTY reports its session', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const host = mount();
    expect(host.textContent).toContain('Preparando agente…');
    act(() => {
      liveSessionId = 'session-1';
      for (const cb of sessionListeners) cb(PANE.id, 'session-1');
    });
    expect(host.textContent).toBe('');
  });

  it('keeps the birth clock across a remount — the 12s warning lands on the original start', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
      });
      const first = mount();
      expect(first.textContent).toContain('Preparando agente…');
      act(() => {
        vi.advanceTimersByTime(PANE_BIRTH_SLOW_AFTER_MS - 1_000);
      });
      expect(first.textContent).toContain('Preparando agente…');
      // Remount (troca de aba, layout, maximização): antes o cronômetro
      // zerava e o aviso de 12s nunca chegava num cold start real.
      act(() => {
        for (const root of roots.splice(0)) root.unmount();
      });
      const second = mount();
      expect(second.textContent).toContain('Preparando agente…');
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(second.textContent).toContain('A abertura está demorando');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses immediately when the session binds, even after going slow', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
      });
      const host = mount();
      act(() => {
        vi.advanceTimersByTime(PANE_BIRTH_SLOW_AFTER_MS);
      });
      expect(host.textContent).toContain('A abertura está demorando');
      act(() => {
        liveSessionId = 'session-late';
        for (const cb of sessionListeners) cb(PANE.id, 'session-late');
      });
      expect(host.textContent).toBe('');
      // O relógio foi limpo: um nascimento depois deste começa do zero.
      act(() => {
        liveSessionId = null;
        for (const cb of sessionListeners) cb(PANE.id, null);
      });
      expect(host.textContent).toContain('Preparando agente…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a session event addressed to another pane', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const host = mount();
    act(() => {
      for (const cb of sessionListeners) cb('pane-other', 'session-other');
    });
    expect(host.textContent).toContain('Preparando agente…');
  });

  it('never covers a pane whose session already died', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'exited');
    });
    expect(mount().textContent).toBe('');
  });

  it('turns a Main refusal into a categorical failure, not an eternal "Preparando agente…"', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const host = mount();
    expect(host.textContent).toContain('Preparando agente…');
    act(() => {
      recordPaneSpawnError(
        PANE.id,
        'A sessão do Grok expirou: a última renovação tem mais de 7 dias. ' +
          'Use "Entrar" no cartão do Grok em Atenção. XAI_API_KEY=xai-segredo-123',
      );
    });
    expect(host.textContent).toContain('Não subiu');
    expect(host.textContent).toContain('Grok precisa de login');
    // Nem erro bruto, nem argv, nem segredo ecoado no card.
    expect(host.textContent).not.toContain('xai-segredo-123');
    expect(host.textContent).not.toContain('A sessão do Grok expirou');
    expect(host.querySelector('.pane-birth--failed')).not.toBeNull();
    // Sem animação em loop: o pulso é de progresso, e aqui nada progride.
    expect(host.querySelector('.pane-birth__pulse')).toBeNull();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    // O logo continua renderizado (identifica QUAL agente não subiu) e o grid
    // do estado failed declara a área dele — sem ela o tile caía numa linha
    // implícita fora do lugar.
    expect(host.querySelector('.pane-birth__identity')).not.toBeNull();
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/styles/base.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const failedRule = css.match(/\.pane-birth--failed\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(failedRule).toMatch(/grid-template-areas:[^;]*'identity headline'[^;]*'identity detail'/s);
    act(() => clearPaneSpawnError(PANE.id));
  });

  // F-1642: "A sessão de “conta b” expirou" deixava o operador sem caminho
  // no próprio pane. A recusa que se resolve com login vira um botão.
  it('conta que precisa de login oferece «Entrar novamente» nela, com um clique', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'exited');
      recordPaneSpawnError(
        PANE.id,
        'A sessão de “conta b” expirou — use «Entrar novamente» nessa conta em Configurações › Contas de IA.',
        { adapterId: 'claude', accountId: 'acct-b', accountLabel: 'conta b' },
      );
    });
    const host = mount();
    expect(host.textContent).toContain('A conta precisa entrar de novo');
    const action = [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Entrar novamente em “conta b”');
    expect(action).toBeDefined();
    expect(host.querySelector('.pane-birth--actionable')).not.toBeNull();

    act(() => action!.click());
    expect(useAccountReloginIntentStore.getState().pending)
      .toMatchObject({ adapterId: 'claude', accountId: 'acct-b' });
    expect(useProductNavigationStore.getState().destination)
      .toMatchObject({ kind: 'settings', section: 'providers' });
    // O card não rouba clique do terminal: só o botão recebe ponteiro.
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/base.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/\.pane-birth__action\s*\{([^}]*)\}/)?.[1]).toMatch(/pointer-events:\s*auto/);
    act(() => {
      clearPaneSpawnError(PANE.id);
      useAccountReloginIntentStore.setState({ pending: null });
    });
  });

  it('recusa sem conta para reautenticar não mostra botão', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'exited');
      recordPaneSpawnError(PANE.id, 'cli_missing: provider binary unavailable');
    });
    const host = mount();
    expect(host.querySelector('button')).toBeNull();
    act(() => clearPaneSpawnError(PANE.id));
  });

  it('shows the refusal even after the host marked the pane exited', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'exited');
      recordPaneSpawnError(PANE.id, 'cli_missing: provider binary unavailable');
    });
    const host = mount();
    expect(host.textContent).toContain('A CLI não está instalada');
    act(() => clearPaneSpawnError(PANE.id));
  });

  // Revisão independente (16/10): estourar os 90 s apagava o relógio persistido, e o estado local
  // ficava em 90 s. Remontar voltava a "Preparando agente…"; um respawn depois de sessão tardia
  // herdava o "Não subiu" do ciclo anterior.
  describe('tentativa vencida (90 s)', () => {
    const spawning = () => act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const bind = (id: string | null) => act(() => {
      liveSessionId = id;
      for (const cb of sessionListeners) cb(PANE.id, id);
    });

    it('continua vencida quando o componente remonta, sem um novo spawn', () => {
      vi.useFakeTimers();
      try {
        spawning();
        const first = mount();
        act(() => { vi.advanceTimersByTime(PANE_BIRTH_FAILED_AFTER_MS); });
        expect(first.textContent).toContain('Não subiu');
        act(() => { for (const root of roots.splice(0)) root.unmount(); });
        expect(mount().textContent).toContain('Não subiu');
        // Já no primeiro quadro, antes de qualquer efeito: nada de "Preparando agente…" piscando.
        expect(renderToString(<PaneBirthOverlay pane={PANE} />)).toContain('Não subiu');
      } finally {
        vi.useRealTimers();
      }
    });

    it('timeout, sessão tardia e respawn: o novo ciclo conta do zero', () => {
      vi.useFakeTimers();
      try {
        spawning();
        const host = mount();
        act(() => { vi.advanceTimersByTime(PANE_BIRTH_FAILED_AFTER_MS); });
        expect(host.textContent).toContain('Não subiu');
        bind('session-late');
        expect(host.textContent).toBe('');
        bind(null);
        expect(host.textContent).toContain('Preparando agente…');
        act(() => { vi.advanceTimersByTime(PANE_BIRTH_SLOW_AFTER_MS - 1_000); });
        expect(host.textContent).toContain('Preparando agente…');
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(host.textContent).toContain('A abertura está demorando');
      } finally {
        vi.useRealTimers();
      }
    });

    it('o pane que sai encerra a tentativa: o próximo spawn começa limpo', () => {
      vi.useFakeTimers();
      try {
        spawning();
        const host = mount();
        act(() => { vi.advanceTimersByTime(PANE_BIRTH_FAILED_AFTER_MS); });
        expect(host.textContent).toContain('Não subiu');
        act(() => { useSessionStateStore.getState().setPaneState(PANE.id, 'exited'); });
        expect(host.textContent).toBe('');
        spawning();
        expect(host.textContent).toContain('Preparando agente…');
      } finally {
        vi.useRealTimers();
      }
    });

    it('transições com o overlay desmontado encerram a tentativa vencida', () => {
      vi.useFakeTimers();
      try {
        spawning();
        const host = mount();
        act(() => { vi.advanceTimersByTime(PANE_BIRTH_FAILED_AFTER_MS); });
        expect(host.textContent).toContain('Não subiu');
        act(() => { for (const root of roots.splice(0)) root.unmount(); });
        act(() => { useSessionStateStore.getState().setPaneState(PANE.id, 'idle'); });
        act(() => { useSessionStateStore.getState().setPaneState(PANE.id, 'exited'); });
        spawning();
        expect(mount().textContent).toContain('Preparando agente…');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a recusa do Main também encerra a tentativa: o retry não herda o prazo vencido', () => {
      vi.useFakeTimers();
      try {
        spawning();
        const host = mount();
        act(() => { vi.advanceTimersByTime(PANE_BIRTH_FAILED_AFTER_MS); });
        expect(host.textContent).toContain('não respondeu no prazo');
        act(() => recordPaneSpawnError(PANE.id, 'cli_missing: provider binary unavailable'));
        expect(host.textContent).toContain('A CLI não está instalada');
        act(() => clearPaneSpawnError(PANE.id));
        expect(host.textContent).toContain('Preparando agente…');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

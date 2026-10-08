/** @vitest-environment jsdom */
/**
 * F-999: a troca de conta no renderer é o caminho mais comum do pacote de
 * continuidade — a cauda vem do xterm (`getScrollbackExcerpt`). O builder
 * compartilhado redige e neutraliza por construção: o renderer não fura.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { FailoverEvent } from '../../shared/account-types';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { detectLimit } from '../../main/orch/limit-detector';
import { dotenvDump, expectNoSecretFragment, hardWrap } from '../../shared/__tests__/synthetic-secrets';

vi.mock('../terminal/terminal-host', () => ({
  respawnWithResume: vi.fn(),
  getScrollbackExcerpt: vi.fn(() => ''),
}));
import { useFailoverController } from './failover-controller';
import { useToastStore } from '../state/toast-store';
import { useLayoutStore } from '../state/layout-store';
import { getScrollbackExcerpt, respawnWithResume } from '../terminal/terminal-host';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Harness() { useFailoverController(); return null; }

describe('F-999: pacote da troca de conta montado no renderer', () => {
  it('cauda do xterm com `cat .env` partido a 80 colunas sai redigida e o motivo fica inerte', async () => {
    let notify!: (event: FailoverEvent) => void;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { accounts: {
      onFailover: (callback: typeof notify) => { notify = callback; return () => {}; },
    } } });
    vi.mocked(getScrollbackExcerpt).mockReturnValue(
      `${hardWrap(dotenvDump(), 80)}\nAPI Error: 400 model_not_found`.slice(-2_400),
    );
    const originalRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'redact-leaf', pane: {
      id: 'redact-pane', kind: 'cli-agent', title: 'Claude', adapterId: 'claude', accountId: 'claude-a',
    } } });
    vi.mocked(respawnWithResume).mockClear();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      notify({
        paneId: 'redact-pane', kind: 'model', reason: 'model_not_found', switched: true, crossAccount: true,
        fromAccountId: 'claude-a', toAccountId: 'claude-b',
        fromAccountLabel: 'conta.um@example.com', toAccountLabel: 'conta.dois@example.org',
      });
      expect(respawnWithResume).toHaveBeenCalledTimes(1);
      const options = vi.mocked(respawnWithResume).mock.calls[0]![2] as { continuityPack?: string };
      const pack = options.continuityPack ?? '';
      expect(pack.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
      expect(pack).toContain('[REDACTED]');
      expectNoSecretFragment(pack);
      for (let start = 1; start < pack.length; start += 1) {
        const hit = detectLimit(pack.slice(start, start + 4_000));
        if (hit) throw new Error(`janela em ${start} disparou ${hit.kind} (${hit.reason})`);
      }
    } finally {
      await act(async () => root.unmount()); container.remove();
      useLayoutStore.setState({ root: originalRoot });
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
    }
  });
});

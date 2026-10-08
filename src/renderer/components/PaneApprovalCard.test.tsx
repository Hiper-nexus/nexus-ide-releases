/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestView } from '../../shared/approval-decision';
import { __resetApprovalRequestsForTests } from '../lib/approval-requests';
import { PaneApprovalCard } from './PaneApprovalCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: (paneId: string) => (paneId === 'pane-1' ? 'sess-1' : null),
  onPaneSessionChange: () => () => undefined,
}));

const REQUEST: ApprovalRequestView = {
  requestId: 'req-1',
  revision: 1,
  sessionId: 'sess-1',
  provider: 'codex',
  tool: 'Bash',
  summary: 'touch probe.txt',
  options: [{ optionId: 'accept' }, { optionId: 'acceptForSession', degradesTo: 'accept' }, { optionId: 'decline' }],
  responseCapability: 'live',
  expiresAt: 0,
};

let pushChanged: ((requests: ApprovalRequestView[]) => void) | null = null;
const api = {
  list: vi.fn(async () => [] as ApprovalRequestView[]),
  respond: vi.fn(async () => ({ status: 'accepted' as const })),
  setVisibleSurfaces: vi.fn(async () => true),
  onChanged: vi.fn((cb: (requests: ApprovalRequestView[]) => void) => {
    pushChanged = cb;
    return () => undefined;
  }),
};

const roots: Root[] = [];

async function mount(visible: boolean, paneId = 'pane-1'): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<PaneApprovalCard paneId={paneId} visible={visible} />);
  });
  return { host, root };
}

async function flushSurfaces(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetApprovalRequestsForTests();
  pushChanged = null;
  (window as unknown as { nexus: { approvals: typeof api } }).nexus = { approvals: api };
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.textContent = '';
});

describe('PaneApprovalCard', () => {
  it('a visible agent pane registers itself as the desktop responder', async () => {
    await mount(true);
    await flushSurfaces();
    expect(api.setVisibleSurfaces).toHaveBeenLastCalledWith(['sess-1']);
  });

  it('a pane off screen is not a responder (the hook answers {} at once)', async () => {
    await mount(false);
    await flushSurfaces();
    expect(api.setVisibleSurfaces).not.toHaveBeenCalledWith(['sess-1']);
  });

  it('renders the pending request and answers with a structured decision', async () => {
    const { host } = await mount(true);
    expect(host.textContent).toBe('');
    await act(async () => pushChanged?.([REQUEST]));
    expect(host.textContent).toContain('Aprovação pendente');
    expect(host.textContent).toContain('touch probe.txt');
    // Codex: "na sessão" degrada — o card diz isso.
    expect(host.textContent).toContain('vale só para este pedido');
    const deny = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Negar')!;
    await act(async () => deny.click());
    expect(api.respond).toHaveBeenCalledWith({ requestId: 'req-1', expectedRevision: 1, optionId: 'decline' });
  });

  it('shows why a refused answer did not land', async () => {
    api.respond.mockResolvedValueOnce({ status: 'rejected', reason: 'closed' } as never);
    const { host } = await mount(true);
    await act(async () => pushChanged?.([REQUEST]));
    const allow = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Permitir')!;
    await act(async () => allow.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('respondido no terminal');
  });

  it('ignores requests of other sessions and closed ones', async () => {
    const { host } = await mount(true);
    await act(async () =>
      pushChanged?.([
        { ...REQUEST, sessionId: 'sess-other' },
        { ...REQUEST, requestId: 'req-2', responseCapability: 'closed' },
      ]),
    );
    expect(host.textContent).toBe('');
  });
});

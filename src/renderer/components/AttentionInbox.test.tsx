/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionInbox } from './AttentionInbox';
import { useAttentionInboxStore } from '../state/attention-inbox-store';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useAgentWaitingStore } from '../state/agent-waiting-store';
import { useGitScmStore } from '../state/git-scm-store';
import { useOrchStore } from '../state/orch-store';
import { useProviderStore } from '../state/provider-store';
import { openCliLoginTerminal } from './settings/cli-login-terminal';

vi.mock('./settings/cli-login-terminal', () => ({
  openCliLoginTerminal: vi.fn(async () => ({ ok: true, paneId: 'login-pane' })),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function mount(): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AttentionInbox />));
  mountedRoots.push(root);
  return host;
}

describe('AttentionInbox', () => {
  beforeEach(() => {
    useAttentionInboxStore.setState({ open: true, count: 0 });
    useAgentNotificationStore.setState({ items: [], open: false });
    useAgentWaitingStore.getState().clear();
    useGitScmStore.setState({ pr: null } as never);
    useOrchStore.setState({ missionSummaries: [] } as never);
    useProviderStore.setState({
      providers: [
        {
          adapterId: 'claude',
          label: 'Claude Code',
          enabled: true,
          installed: true,
          authStrategy: 'login-needed',
          loginCommand: 'claude /login',
        },
        {
          adapterId: 'grok',
          label: 'Grok',
          enabled: true,
          installed: true,
          authStrategy: 'login-needed',
          loginCommand: 'grok auth login',
        },
      ],
    } as never);
    vi.mocked(openCliLoginTerminal).mockClear();
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.replaceChildren();
    useAttentionInboxStore.setState({ open: false, count: 0 });
  });

  it('mostra o nome da CLI por extenso, o que ela pede, e não esmaga o card em 22px', () => {
    mount();
    const panel = document.querySelector('.agent-notif__panel');
    expect(panel?.classList.contains('agent-notif__panel--rail')).toBe(true);
    const items = [...document.querySelectorAll('.agent-notif__item')];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.querySelector('.agent-notif__status-icon')).not.toBeNull();
      expect(item.querySelector('.agent-notif__body')).not.toBeNull();
      expect(item.children.length).toBeGreaterThanOrEqual(2);
    }
    const text = document.body.textContent ?? '';
    expect(text).toContain('Claude Code');
    expect(text).toContain('Grok');
    expect(text).toMatch(/Login/i);
    expect(text).not.toMatch(/^C\.\.\./m);
    const claudeBtn = [...document.querySelectorAll('button')].find((button) =>
      /Claude Code/i.test(button.getAttribute('aria-label') ?? ''),
    );
    expect(claudeBtn?.getAttribute('aria-label')).toBe('Entrar no Claude Code');
    expect(claudeBtn?.textContent).toMatch(/Entrar/);
  });

  it('Entrar no Claude Code abre o login daquela CLI, não um card genérico', () => {
    mount();
    const claudeBtn = [...document.querySelectorAll('button')].find((button) =>
      (button.getAttribute('aria-label') ?? '') === 'Entrar no Claude Code',
    );
    expect(claudeBtn).toBeTruthy();
    act(() => claudeBtn!.click());
    expect(openCliLoginTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'claude /login' }),
    );
  });
});

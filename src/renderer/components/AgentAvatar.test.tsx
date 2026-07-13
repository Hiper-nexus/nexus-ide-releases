/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import {
  AgentAvatar,
  resolveAgentCategory,
  summarizeAgentStates,
} from './AgentAvatar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const squad: Squad = {
  id: 'nexus-research',
  name: 'Pesquisa',
  createdAt: '1',
  builtin: true,
  orchestratorInstructions: '',
  agents: [
    { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'codex' },
    { id: 'scout-a', agentName: 'Scout A', category: 'scout', cli: 'agy' },
  ],
};

describe('AgentAvatar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves the visual identity from the real squad role', () => {
    expect(resolveAgentCategory([squad], 'Scout A', 'worker')).toBe('scout');
    expect(resolveAgentCategory([squad], 'unknown', 'orchestrator')).toBe(
      'orchestrator',
    );
    expect(resolveAgentCategory([], 'unknown', 'worker')).toBe('executor');
  });

  it('exposes operational state to assistive technology and CSS', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <AgentAvatar
          category="reviewer"
          state="busy"
          size="micro"
          label="Security"
        />,
      );
    });

    const avatar = host.querySelector('.agent-avatar');
    expect(avatar?.classList.contains('agent-avatar--busy')).toBe(true);
    expect(avatar?.classList.contains('agent-avatar--micro')).toBe(true);
    expect(avatar?.getAttribute('aria-label')).toBe(
      'Security, reviewer, trabalhando',
    );
    expect(avatar?.querySelector('img')?.getAttribute('alt')).toBe('');

    act(() => root.unmount());
  });

  it('summarizes a mixed live crew without hiding attention states', () => {
    expect(
      summarizeAgentStates(['busy', 'busy', 'idle', 'waiting', 'hibernated']),
    ).toBe('2 trabalhando · 1 requer atenção · 1 pronto · 1 dormindo');
    expect(summarizeAgentStates(['offline', 'offline'])).toBe('2 configurados');
  });
});

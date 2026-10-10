import { describe, expect, it } from 'vitest';
import { isToolAllowedForRole } from './gate';
import { NEXUS_BROWSER_WORKER_TOOLS } from './nexus-browser-policy';

describe('worker browser and desktop tool allowlists', () => {
  it.each([
    'nexus_browser_open', 'nexus_browser_navigate', 'nexus_browser_read',
    'nexus_browser_screenshot', 'nexus_browser_click', 'nexus_browser_fill',
    'nexus_browser_press', 'nexus_browser_scroll', 'nexus_browser_hover',
    'nexus_browser_responsive', 'nexus_browser_do', 'nexus_computer_do',
  ])('allows %s for the worker whatever the token allowlist says', (tool) => {
    expect(isToolAllowedForRole('worker', null, tool)).toBe(true);
    expect(isToolAllowedForRole('worker', [tool], tool)).toBe(true);
    // F-1157: a allowlist do token não nega mais — vazia ou com outra tool,
    // o worker alcança o navegador e o desktop.
    expect(isToolAllowedForRole('worker', [], tool)).toBe(true);
    expect(isToolAllowedForRole('worker', ['nexus_file_read'], tool)).toBe(true);
  });
});

describe('F-797: a allowlist padrão do worker não limita mais o alcance (F-1157)', () => {
  const defaults = [...NEXUS_BROWSER_WORKER_TOOLS];
  it.each([...NEXUS_BROWSER_WORKER_TOOLS])('%s passa pelo gate do worker', (tool) => {
    expect(isToolAllowedForRole('worker', defaults, tool)).toBe(true);
  });
  it.each([
    'nexus_browser_click', 'nexus_browser_fill', 'nexus_browser_press', 'nexus_browser_scroll',
    'nexus_browser_hover', 'nexus_browser_responsive', 'nexus_browser_do', 'nexus_computer_do',
    'nexus_terminal_run', 'nexus_file_write', 'nexus_git_push',
  ])('%s também está ao alcance do worker padrão', (tool) => {
    // F-1157: antes ficava fora da lista padrão; agora todo agente alcança tudo.
    expect(isToolAllowedForRole('worker', defaults, tool)).toBe(true);
  });
});
